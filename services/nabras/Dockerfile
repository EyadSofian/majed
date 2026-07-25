FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8080
# Railway (and most PaaS) inject the port to bind as $PORT; a hardcoded port
# means the healthcheck never passes and the deploy looks "stuck".
# --proxy-headers so request.client.host is the real client IP behind the proxy,
# otherwise every guest shares a single rate-limit bucket.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips '*'"]
