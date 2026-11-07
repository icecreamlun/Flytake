import type { FC } from 'react';
import { TILES_PROVIDER } from '../config';
import { useFlytake } from '../state/store';

/** Setup instructions when no tiles credentials are configured, or the tiles server refuses them. */
export const MissingKey: FC = () => {
  const tilesError = useFlytake((s) => s.tilesError);
  const missing = TILES_PROVIDER == null;
  if (!missing && tilesError == null) return null;
  // fetch() rejects with a TypeError ("Failed to fetch", "Load failed", "NetworkError ...") when
  // the server was never reached: that is the network, not the key.
  const offline = !missing && /failed to fetch|load failed|networkerror|network error/i.test(tilesError ?? '');
  const server = TILES_PROVIDER === 'google' ? 'Google Map Tiles API' : 'Cesium ion';

  if (offline) {
    return (
      <div className="setup">
        <div className="setup-card">
          <div className="wordmark">Flytake</div>
          <h2 className="setup-title">Can’t reach the 3D tiles server</h2>
          <p className="setup-lede">
            {server} could not be reached (<code>{tilesError}</code>). Check the network connection or VPN, then try again.
          </p>
          <button className="pill" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="wordmark">Flytake</div>
        <h2 className="setup-title">{missing ? 'Connect the 3D world' : 'The 3D tiles server refused the request'}</h2>
        {missing ? (
          <p className="setup-lede">
            Flytake streams Google Photorealistic 3D Tiles. Add a key and restart the dev server — the sky and stars
            behind this card are already running.
          </p>
        ) : (
          <p className="setup-lede">
            {server} answered: <code>{tilesError}</code>. Check the key below, then restart the dev server.
          </p>
        )}
        <ol className="setup-steps">
          <li>
            In Google Cloud Console, enable the <strong>Map Tiles API</strong> and create an API key (restrict it to the
            Map Tiles API and your HTTP referrers).
          </li>
          <li>
            Create <code>.env.local</code> in the project root:
            <pre className="mono">VITE_GOOGLE_MAPS_API_KEY=your-key</pre>
            <span className="setup-alt">
              Or use Cesium ion (asset 2275207, Google Photorealistic 3D Tiles): <code>VITE_CESIUM_ION_TOKEN=your-token</code>
            </span>
          </li>
          <li>
            Restart: <code>pnpm dev</code>
          </li>
        </ol>
      </div>
    </div>
  );
};
