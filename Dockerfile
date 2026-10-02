# ── RemoteHost signaling + APK-builder server ─────────────────────────────
FROM node:20-slim

# Install JDK + curl (needed to run uber-apk-signer and fetch the template)
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

# Download the template APK from the GitHub Release.
# ⬇️⬇️⬇️  REPLACE THIS URL WITH YOURS FROM STEP A.6  ⬇️⬇️
RUN curl -fL -o /app/template.apk \
    https://github.com/walterhizenburg1-ops/remote-control-server/releases/download/v1-template/template.apk

# Copy app code + admin panel
COPY server.js ./
COPY admin.html ./
COPY admin-remote.html ./

# Sanity check: everything must be present
RUN test -f /app/template.apk && \
    test -f /app/uber-apk-signer.jar && \
    test -f /app/server.js && \
    echo "✅ template + signer + server present"

EXPOSE 3000

CMD ["node", "server.js"]
