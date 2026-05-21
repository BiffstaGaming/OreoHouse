<?php
// Central configuration for the OreoHouse PHP web client.
//
// All values come from environment variables so the same image can be
// pointed at different Go servers without rebuilding.

declare(strict_types=1);

/**
 * Resolve the Go server URL the PHP process itself uses for
 * server-to-server REST calls (login, logout). Inside Docker this is
 * typically the service-name URL (e.g. http://oreohouse:8080). On bare
 * metal it might be http://localhost:8080.
 */
function oreo_server_url(): string
{
    $url = getenv('OREO_SERVER_URL');
    if ($url === false || $url === '') {
        $url = 'http://localhost:8080';
    }
    return rtrim($url, '/');
}

/**
 * Resolve the Go server URL the BROWSER should use. This often differs
 * from the PHP-side URL: PHP talks to oreohouse:8080 via Docker DNS,
 * but the user's browser talks to e.g. http://192.168.1.100:8080
 * across the LAN.
 *
 * If OREO_BROWSER_SERVER_URL isn't set we fall back to
 * OREO_SERVER_URL on the assumption that PHP and the browser are on
 * the same network (i.e. local dev without Docker).
 */
function oreo_browser_server_url(): string
{
    $url = getenv('OREO_BROWSER_SERVER_URL');
    if ($url === false || $url === '') {
        // No explicit override — derive from the request host so the
        // browser hits the same machine on port 8080 by default. This
        // is what makes the "open it in any browser on the LAN" story
        // just work without configuration in 90% of homes.
        $scheme = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        // Strip any :port suffix from the host — the Go server lives on
        // 8080 regardless of what port the web app is served from.
        if (($colon = strrpos($host, ':')) !== false) {
            $host = substr($host, 0, $colon);
        }
        return $scheme . '://' . $host . ':8080';
    }
    return rtrim($url, '/');
}
