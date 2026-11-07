/**
 * Pilot input: keyboard laid out like a Mode 2 remote, plus any standard-mapping gamepad.
 *
 *   Left stick  (W/S, A/D)          throttle (climb / descend), yaw (turn left / right)
 *   Right stick (arrows or I/J/K/L)  pitch (forward / back), roll (sideways)
 *   T  take off / land        1 / 2 / 3  Cine / Normal / Sport
 *   G  rule-of-thirds grid    H or ?     controls help    M  mute    R  reset (crashed / landed)
 *   Esc  leave the drone
 *
 * Gamepad: left stick throttle + yaw, right stick pitch + roll, A take off / land, B reset,
 * LB / RB flight mode, Y grid, View/Back help, Menu/Start leave.
 * Keyboard axes ramp like a spring-centred stick, so a tap is a gentle nudge.
 */
import { neutralSticks, type Sticks } from './physics';
import type { FlightMode } from './specs';

export interface InputActions {
  takeoffLand: boolean;
  mode: FlightMode | null;
  /** -1 / +1 = step through Cine / Normal / Sport */
  modeStep: number;
  exit: boolean;
  grid: boolean;
  help: boolean;
  mute: boolean;
  reset: boolean;
}

const noActions = (): InputActions => ({
  takeoffLand: false,
  mode: null,
  modeStep: 0,
  exit: false,
  grid: false,
  help: false,
  mute: false,
  reset: false,
});

type Axis = keyof Sticks;
const AXIS_KEYS: Record<Axis, { pos: string[]; neg: string[] }> = {
  throttle: { pos: ['KeyW'], neg: ['KeyS'] },
  yaw: { pos: ['KeyD'], neg: ['KeyA'] },
  pitch: { pos: ['ArrowUp', 'KeyI'], neg: ['ArrowDown', 'KeyK'] },
  roll: { pos: ['ArrowRight', 'KeyL'], neg: ['ArrowLeft', 'KeyJ'] },
};
const AXES: Axis[] = ['throttle', 'yaw', 'pitch', 'roll'];
const HANDLED = new Set([
  ...AXES.flatMap((a) => [...AXIS_KEYS[a].pos, ...AXIS_KEYS[a].neg]),
  'KeyT',
  'Digit1',
  'Digit2',
  'Digit3',
  'KeyG',
  'KeyH',
  'Slash',
  'KeyM',
  'KeyR',
  'Escape',
  'Space',
]);

/** keyboard stick travel per second toward full deflection / back to centre */
const KEY_RISE = 3.2;
const KEY_RETURN = 7;
const DEADZONE = 0.1;

function deadzone(v: number): number {
  const a = Math.abs(v);
  if (!Number.isFinite(v) || a < DEADZONE) return 0;
  return (Math.sign(v) * (a - DEADZONE)) / (1 - DEADZONE);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el != null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
}

export class DroneInput {
  private readonly down = new Set<string>();
  private readonly keyboard: Sticks = neutralSticks();
  private pending: InputActions = noActions();
  private prevButtons: boolean[] = [];
  /** true when the last non-neutral input came from a gamepad */
  gamepadActive = false;
  gamepadConnected = false;

  /** Listen on window; `onGesture` runs inside the key handler (audio unlock needs one). */
  attach(onGesture?: () => void): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (!HANDLED.has(e.code)) return;
      e.preventDefault();
      onGesture?.();
      this.gamepadActive = false;
      this.down.add(e.code);
      if (e.repeat) return;
      const a = this.pending;
      switch (e.code) {
        case 'KeyT':
          a.takeoffLand = true;
          break;
        case 'Digit1':
          a.mode = 'cine';
          break;
        case 'Digit2':
          a.mode = 'normal';
          break;
        case 'Digit3':
          a.mode = 'sport';
          break;
        case 'KeyG':
          a.grid = true;
          break;
        case 'KeyH':
        case 'Slash':
          a.help = true;
          break;
        case 'KeyM':
          a.mute = true;
          break;
        case 'KeyR':
          a.reset = true;
          break;
        case 'Escape':
          a.exit = true;
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.down.delete(e.code);
    };
    // A key held while the window loses focus never sends keyup: drop everything.
    const onBlur = () => this.down.clear();
    const onPad = () => onGesture?.();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('gamepadconnected', onPad);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('gamepadconnected', onPad);
      this.down.clear();
    };
  }

  /** Sample the sticks for this frame and take the actions queued since the last call. */
  read(dt: number, out: Sticks): InputActions {
    // Keyboard: ramp each virtual stick toward the pressed direction.
    for (const axis of AXES) {
      const { pos, neg } = AXIS_KEYS[axis];
      const target = (pos.some((k) => this.down.has(k)) ? 1 : 0) - (neg.some((k) => this.down.has(k)) ? 1 : 0);
      const v = this.keyboard[axis];
      const rate = target === 0 || Math.sign(target) !== Math.sign(v) ? KEY_RETURN : KEY_RISE;
      const step = rate * dt;
      this.keyboard[axis] = Math.abs(target - v) <= step ? target : v + Math.sign(target - v) * step;
    }

    const actions = this.pending;
    this.pending = noActions();
    Object.assign(out, this.keyboard);

    const pad = this.gamepad();
    this.gamepadConnected = pad != null;
    if (pad != null) {
      const axes = pad.axes;
      const g: Sticks = {
        throttle: -deadzone(axes[1] ?? 0),
        yaw: deadzone(axes[0] ?? 0),
        pitch: -deadzone(axes[3] ?? 0),
        roll: deadzone(axes[2] ?? 0),
      };
      if (AXES.some((a) => g[a] !== 0)) this.gamepadActive = true;
      for (const a of AXES) out[a] = Math.max(-1, Math.min(1, out[a] + g[a]));

      const pressed = pad.buttons.map((b) => b.pressed);
      const edge = (i: number) => pressed[i] === true && this.prevButtons[i] !== true;
      if (edge(0)) actions.takeoffLand = true;
      if (edge(1)) actions.reset = true;
      if (edge(3)) actions.grid = true;
      if (edge(4)) actions.modeStep -= 1;
      if (edge(5)) actions.modeStep += 1;
      if (edge(8)) actions.help = true;
      if (edge(9)) actions.exit = true;
      if (pressed.some(Boolean)) this.gamepadActive = true;
      this.prevButtons = pressed;
    }
    return actions;
  }

  private gamepad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    for (const pad of navigator.getGamepads()) {
      if (pad != null && pad.connected && pad.axes.length >= 4) return pad;
    }
    return null;
  }
}
