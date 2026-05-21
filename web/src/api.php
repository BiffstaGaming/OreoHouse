<?php
// Server-side REST helpers. PHP only talks to the Go server during the
// auth flow (login + logout); after that it hands off to the browser.

declare(strict_types=1);

require_once __DIR__ . '/config.php';

/**
 * POST /api/auth/login.
 *
 * Returns ['ok' => bool, 'data' => array|null, 'error' => string|null,
 * 'status' => int].
 */
function oreo_api_login(string $username, string $password): array
{
    $url = oreo_server_url() . '/api/auth/login';
    $body = json_encode(['username' => $username, 'password' => $password], JSON_THROW_ON_ERROR);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
    ]);
    $resp = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($resp === false) {
        return ['ok' => false, 'data' => null, 'error' => 'Cannot reach server: ' . $err, 'status' => 0];
    }

    $decoded = json_decode((string) $resp, true);
    if ($status !== 200) {
        $msg = is_array($decoded) && isset($decoded['error']) ? (string) $decoded['error'] : 'Login failed';
        return ['ok' => false, 'data' => null, 'error' => $msg, 'status' => $status];
    }
    return ['ok' => true, 'data' => $decoded, 'error' => null, 'status' => $status];
}

/**
 * POST /api/auth/logout. Best-effort; PHP session clears regardless.
 */
function oreo_api_logout(string $token): void
{
    $url = oreo_server_url() . '/api/auth/logout';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 5,
    ]);
    curl_exec($ch);
    curl_close($ch);
}
