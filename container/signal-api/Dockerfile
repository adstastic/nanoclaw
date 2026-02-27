# Build signal-cli from master to get binary ACI fix (signal-service-java v2.15.3_unofficial_138).
# Signal Desktop v8.0.0 (Feb 25, 2026) switched to binary ACI encoding for mentions/quotes.
# signal-cli 0.13.24 and earlier only read string ACI variants → silently drops them.
# Fix: https://github.com/AsamK/signal-cli/issues/1940

FROM eclipse-temurin:25-jdk AS builder
RUN apt-get update && apt-get install -y git
# Pinned to signal-cli master as of 2026-02-27 (first commit after binary ACI fix)
ARG SIGNAL_CLI_COMMIT=f9cbfa6d6c92291b54a31743a68d913dd819a4cb
RUN git clone https://github.com/AsamK/signal-cli.git /build && \
    cd /build && git checkout $SIGNAL_CLI_COMMIT
WORKDIR /build
RUN ./gradlew installDist

FROM bbernhard/signal-cli-rest-api:0.97
# Base image (0.97) bundles this version of signal-cli; the JNI extraction below depends on this path
ARG SIGNAL_CLI_BASE_VERSION=0.13.23
COPY --from=builder /build/build/install/signal-cli /opt/signal-cli-master
# Copy Java 25 JRE (base image only has Java 21, but master needs 25)
COPY --from=builder /opt/java/openjdk /opt/java25
# Inject Linux ARM64 native JNI lib from base image's patched jar into master's jar
RUN python3 -c "\
import zipfile, glob, sys; \
old_jars = glob.glob('/opt/signal-cli-${SIGNAL_CLI_BASE_VERSION}/lib/libsignal-client-*.jar'); \
new_jars = glob.glob('/opt/signal-cli-master/lib/libsignal-client-*.jar'); \
if not old_jars: sys.exit('ERROR: No libsignal-client jar in /opt/signal-cli-${SIGNAL_CLI_BASE_VERSION}/lib/'); \
if not new_jars: sys.exit('ERROR: No libsignal-client jar in /opt/signal-cli-master/lib/'); \
if len(old_jars) > 1: sys.exit(f'ERROR: Multiple base jars: {old_jars}'); \
if len(new_jars) > 1: sys.exit(f'ERROR: Multiple master jars: {new_jars}'); \
old_jar, new_jar = old_jars[0], new_jars[0]; \
with zipfile.ZipFile(old_jar) as oz: \
    if 'libsignal_jni.so' not in oz.namelist(): \
        sys.exit(f'ERROR: libsignal_jni.so not found in {old_jar}'); \
    data = oz.read('libsignal_jni.so'); \
if len(data) < 1024: sys.exit(f'ERROR: libsignal_jni.so suspiciously small ({len(data)} bytes)'); \
with zipfile.ZipFile(new_jar, 'a') as nz: nz.writestr('libsignal_jni.so', data); \
print(f'Injected {len(data)} bytes from {old_jar} into {new_jar}')"
# Symlink java/signal-cli so supervisor's PATH-based invocations use the new versions
ENV JAVA_HOME=/opt/java25
RUN ln -sf /opt/java25/bin/java /usr/bin/java && \
    ln -sf /opt/signal-cli-master/bin/signal-cli /usr/bin/signal-cli
