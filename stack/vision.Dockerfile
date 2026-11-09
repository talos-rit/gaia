# Pi-Vision. Dependencies are pinned in vision-requirements.lock (all have aarch64 wheels, so
# nothing compiles). They sit in their own layer, so a code change rebuilds in seconds.
FROM python:3.11-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=gaia vision-requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements.lock
# APP_DIR = directory holding main.py; MODEL = pose model. Both relative to the source repo root.
ARG APP_DIR=.
ARG MODEL=model.onnx
COPY ${MODEL} /opt/talos/model.onnx
COPY ${APP_DIR}/ /opt/talos/vision/
WORKDIR /opt/talos/vision
ENV PYTHONUNBUFFERED=1
STOPSIGNAL SIGINT
CMD ["python", "main.py", "--model", "/opt/talos/model.onnx"]
