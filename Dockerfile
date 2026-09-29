# ── RemoteHost signaling + APK-builder server ─────────────────────────────
FROM node:20-slim

# Install JDK + curl (needed to run uber-apk-signer)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        curl \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Download uber-apk-signer once during image build
RUN curl -L -o /app/uber-apk-signer.jar \
    https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar && \
    ls -lh /app/uber-apk-signer.jar

# Copy app code + template APK
COPY server.js ./
COPY template.apk ./

# Sanity check: both files must exist
RUN test -f /app/template.apk && \
    test -f /app/uber-apk-signer.jar && \
    echo "✅ template + signer present"

EXPOSE 3000

CMD ["node", "server.js"]
