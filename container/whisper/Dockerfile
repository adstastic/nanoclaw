# Stage 1: build whisper.cpp server from source
FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y \
    build-essential cmake git libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp /whisper
WORKDIR /whisper
RUN cmake -B build \
    -DWHISPER_BUILD_SERVER=ON \
    -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j$(nproc) --target whisper-server

# Stage 2: minimal runtime image
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y libcurl4 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /whisper/build/bin/whisper-server /usr/local/bin/whisper-server

EXPOSE 2022

# Model is mounted at /models at runtime — not baked in
CMD ["whisper-server", \
     "--model", "/models/ggml-large-v3-turbo.bin", \
     "--host", "0.0.0.0", \
     "--port", "2022", \
     "--inference-path", "/v1/audio/transcriptions"]
