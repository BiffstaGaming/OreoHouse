<?php
// Login page. If already logged in, jumps straight to chat.php.
//
// Submitting the form posts back to this page, which calls the Go
// server's POST /api/auth/login and stores the bearer token in the
// PHP session before redirecting.

declare(strict_types=1);

require_once __DIR__ . '/../src/session.php';
require_once __DIR__ . '/../src/api.php';

oreo_start_session();
if (oreo_session_token() !== null) {
    header('Location: /chat.php');
    exit;
}

$error = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim((string) ($_POST['username'] ?? ''));
    $password = (string) ($_POST['password'] ?? '');

    if ($username === '' || $password === '') {
        $error = 'Username and password are required.';
    } else {
        $result = oreo_api_login($username, $password);
        if ($result['ok']) {
            oreo_login_session($result['data']['token'], $result['data']['user']);
            header('Location: /chat.php');
            exit;
        }
        $error = $result['error'] ?? 'Login failed.';
    }
}

?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="theme-color" content="#2c5dab" />
<title>OreoHouse — Sign in</title>
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" type="image/png" href="/assets/img/icon.png" />
<link rel="apple-touch-icon" href="/assets/img/icon.png" />
<link rel="stylesheet" href="<?= htmlspecialchars(oreo_asset('/assets/css/style.css')) ?>" />
</head>
<body class="login-body">
<main class="login-card">
    <div class="login-brand">
        <img class="brand-logo" src="/assets/img/logo.png" alt="OreoHouse" />
        <p class="subtitle">Family chat — web edition</p>
    </div>

    <?php if ($error !== null): ?>
        <div class="alert"><?= htmlspecialchars($error, ENT_QUOTES) ?></div>
    <?php endif; ?>

    <form method="post" autocomplete="on" class="login-form">
        <label>
            <span>Username</span>
            <input type="text" name="username" required autofocus value="<?= htmlspecialchars((string) ($_POST['username'] ?? ''), ENT_QUOTES) ?>" />
        </label>
        <label>
            <span>Password</span>
            <input type="password" name="password" required autocomplete="current-password" />
        </label>
        <button type="submit" class="primary">Sign in</button>
    </form>

    <p class="login-footnote">
        This is the lightweight browser client. The full desktop app has
        more features (nudges, system tray, drag-drop folders).
    </p>
</main>
</body>
</html>
