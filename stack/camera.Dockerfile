# Cam Streamer: cam_streamer's scripts/stream_camera.sh publishing to MediaMTX on the host.
# Debian's ffmpeg includes h264_v4l2m2m for the Pi's hardware encoder. All settings are env vars
# (see compose.yaml), so the image is the same for every Pi.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/stream_camera.sh /opt/cam_streamer/stream_camera.sh
# A working copy checked out on Windows may have CRLF line endings, which bash chokes on.
RUN sed -i 's/\r$//' /opt/cam_streamer/stream_camera.sh && chmod 0755 /opt/cam_streamer/stream_camera.sh
STOPSIGNAL SIGINT
ENTRYPOINT ["/opt/cam_streamer/stream_camera.sh"]
