<?php
// PHP-session helpers. The session stores ONLY the Go server's bearer
// token + the user's profile snapshot at login time. Everything else
// is fetched fresh by the browser over REST/WS.

declare(strict_types=1);

function oreo_start_session(): void
{
    if (session_status() === PHP_SESSION_NONE) {
        session_name('oreohouse_sid');
        session_start();
    }
}

function oreo_login_session(string $token, array $user): void
{
    oreo_start_session();
    $_SESSION['token'] = $token;
    $_SESSION['user'] = $user;
    // Regenerate the session ID after login to defeat session fixation.
    session_regenerate_id(true);
}

function oreo_clear_session(): void
{
    oreo_start_session();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
    }
    session_destroy();
}

function oreo_session_token(): ?string
{
    oreo_start_session();
    return isset($_SESSION['token']) ? (string) $_SESSION['token'] : null;
}

function oreo_session_user(): ?array
{
    oreo_start_session();
    return isset($_SESSION['user']) && is_array($_SESSION['user']) ? $_SESSION['user'] : null;
}

/**
 * Redirect to the login page if no session exists. Intended for use
 * at the top of authenticated pages.
 */
function oreo_require_login(): void
{
    if (oreo_session_token() === null) {
        header('Location: /index.php');
        exit;
    }
}
