<?php
// Main chat application page. Guarded by oreo_require_login(); after
// that, hands off to the SPA in /assets/js/app.js. The browser does
// all REST + WS interaction directly with the Go server — the server
// URL is injected here so the JS doesn't have to guess.

declare(strict_types=1);

require_once __DIR__ . '/../src/session.php';
require_once __DIR__ . '/../src/config.php';

oreo_require_login();

$token = oreo_session_token();
$user = oreo_session_user();
$browserServerUrl = oreo_browser_server_url();

// The JSON-encoded blob the SPA reads on boot.
$bootstrap = [
    'serverUrl' => $browserServerUrl,
    'token' => $token,
    'user' => $user,
    'version' => OREO_VERSION,
    'repoUrl' => OREO_REPO_URL,
];

?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="theme-color" content="#2c5dab" />
<title>OreoHouse</title>
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" type="image/png" href="/assets/img/icon.png" />
<link rel="apple-touch-icon" href="/assets/img/icon.png" />
<link rel="stylesheet" href="<?= htmlspecialchars(oreo_asset('/assets/css/style.css')) ?>" />
</head>
<body class="chat-body">
<div id="app">
    <div class="loading">Connecting…</div>
</div>

<!-- Bootstrap data injected by PHP; read by app.js on boot. -->
<script>
    window.OREO = <?= json_encode($bootstrap, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES) ?>;
</script>
<!-- PWA service worker registration. No-op fetch handler — the SW
     exists purely so browsers offer "Install app". Safe to fail
     silently in HTTP-only contexts (the spec requires HTTPS or
     localhost for SW; LAN HTTP IPs work in localhost but not always
     elsewhere). -->
<script>
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function (err) {
                console.warn('SW registration failed:', err);
            });
        });
    }
</script>
<script src="<?= htmlspecialchars(oreo_asset('/assets/js/api.js')) ?>"></script>
<script src="<?= htmlspecialchars(oreo_asset('/assets/js/ws.js')) ?>"></script>
<script src="<?= htmlspecialchars(oreo_asset('/assets/js/ui.js')) ?>"></script>
<script src="<?= htmlspecialchars(oreo_asset('/assets/js/helpers.js')) ?>"></script>
<script src="<?= htmlspecialchars(oreo_asset('/assets/js/app.js')) ?>"></script>
</body>
</html>
