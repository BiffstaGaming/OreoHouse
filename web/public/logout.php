<?php
// Logout page. Best-effort call to the Go server's logout endpoint to
// invalidate the bearer token, then clears the PHP session and bounces
// back to the login page.

declare(strict_types=1);

require_once __DIR__ . '/../src/session.php';
require_once __DIR__ . '/../src/api.php';

$token = oreo_session_token();
if ($token !== null) {
    oreo_api_logout($token);
}
oreo_clear_session();

header('Location: /index.php');
exit;
