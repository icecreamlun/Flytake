/** Replies about the current fixed flight; never claim to modify its camera path. */
export function followUpReply(text: string, approved: boolean): string {
  if (/\b(speed|faster|slower|pace)\b/i.test(text)) return 'During the preview, use the speed button to switch between 1×, 2× and 3× playback. The planned camera path stays the same.';
  if (/\b(long|duration|minute|seconds)\b/i.test(text)) return 'The flight is one minute long, with a short route overview before it starts. You can watch it again from the preview card above.';
  if (/\b(start|takeoff|take.off|launch)\b/i.test(text)) return 'The flight starts at Ferry Plaza, beside the Ferry Building, and features the clock tower and waterfront.';
  if (/\b(change|adjust|different|edit|shorter|longer)\b/i.test(text)) return 'The current shot has a fixed camera path. I can help you review it and explain the flight, but I cannot change the route yet. You can replay it from the card above.';
  if (/\b(route|approve|save|keep)\b/i.test(text)) return approved ? 'Your flight plan is approved and its route is visible in the scene. Use Preview flight to watch it again.' : 'After watching the preview, select Approve preview to show its route on the map and unlock Preview flight. You can return to chat without approving and decide later.';
  return 'We are planning a one-minute Ferry Building flight featuring the plaza, clock tower and waterfront. You can replay the preview above, or ask about its duration, starting point or route.';
}
