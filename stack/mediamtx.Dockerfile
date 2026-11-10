# MediaMTX, the RTSP server the camera publishes to. The official image plus Gaia's config
# (stack/mediamtx.yml); the image has no shell, so Gaia checks it through its API instead.
ARG MEDIAMTX_VERSION=1.15.3
FROM bluenviron/mediamtx:${MEDIAMTX_VERSION}
COPY --from=gaia mediamtx.yml /mediamtx.yml
