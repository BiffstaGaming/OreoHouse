# OreoHouse PHP web client.
#
# Serves the browser-based chat UI for guest/no-install users. Talks to
# the Go server (oreohouse container) over the LAN for REST + WS.
#
# Build context is the repository root; web/ is the document root.

FROM php:8.3-apache

# Apache rewrite module so .htaccess clean URLs work.
RUN a2enmod rewrite headers

# Allow AllowOverride for the document root so our .htaccess takes effect.
RUN sed -ri \
    -e 's!<Directory /var/www/>!<Directory /var/www/html>!g' \
    -e 's!AllowOverride None!AllowOverride All!g' \
    /etc/apache2/apache2.conf || true

COPY web/public/ /var/www/html/
# Mirror the local dev layout so ../src/foo.php works in both
# environments: `php -S localhost:8000 -t web/public` and Apache.
COPY web/src/ /var/www/src/

ENV OREO_SERVER_URL="http://oreohouse:8080" \
    OREO_BROWSER_SERVER_URL="" \
    PHP_INI_DIR=/usr/local/etc/php

# Bigger upload limit so attachment uploads through the browser match the
# Go server's 25 MiB default cap. Bumping post_max_size implicitly.
RUN { \
        echo "upload_max_filesize = 30M"; \
        echo "post_max_size = 32M"; \
        echo "session.cookie_httponly = 1"; \
        echo "session.cookie_samesite = Lax"; \
    } > "$PHP_INI_DIR/conf.d/oreohouse.ini"

EXPOSE 80
