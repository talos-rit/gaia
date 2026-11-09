# Operator (erv). The build context is a clean copy of the chosen source (git ref or working copy),
# prepared by Gaia. Tests run during the build, so a failing test never produces an image.
#
# The toolchain runs on the *build* machine's architecture. On an ARM Mac that's a native
# arm64 build; on an x86 Windows/Linux laptop it cross-compiles to arm64 (fast) instead of
# compiling under QEMU emulation (slow). Tests are compiled and run natively either way.
FROM --platform=$BUILDPLATFORM debian:bookworm AS build
ARG BUILDARCH
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake g++ make pkg-config libcpputest-dev \
 && if [ "$BUILDARCH" != "$TARGETARCH" ]; then apt-get install -y --no-install-recommends g++-aarch64-linux-gnu; fi \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
ARG RUN_TESTS=1
RUN if [ "$RUN_TESTS" = 1 ]; then \
      cmake -S . -B /test -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON \
   && cmake --build /test --parallel "$(nproc)" \
   && ctest --test-dir /test --output-on-failure; \
    fi
RUN if [ "$BUILDARCH" = "$TARGETARCH" ]; then CROSS=""; else \
      CROSS="-DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 -DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc -DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++"; fi \
 && cmake -S . -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF $CROSS \
 && cmake --build /build --parallel "$(nproc)"

FROM debian:bookworm-slim
COPY --from=build /build/bin/erv /opt/talos/erv
STOPSIGNAL SIGINT
CMD ["/opt/talos/erv", "/opt/talos/operator.conf"]
