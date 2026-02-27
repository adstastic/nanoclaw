# Build signal-cli from master to get binary ACI fix (signal-service-java v2.15.3_unofficial_138).
# Signal Desktop v8.0.0 (Feb 25, 2026) switched to binary ACI encoding for mentions/quotes.
# signal-cli 0.13.24 and earlier only read string ACI variants → silently drops them.
# Fix: https://github.com/AsamK/signal-cli/issues/1940

FROM eclipse-temurin:25-jdk AS builder
RUN apt-get update && apt-get install -y git
ARG SIGNAL_CLI_COMMIT=f9cbfa6d6c92291b54a31743a68d913dd819a4cb
RUN git clone https://github.com/AsamK/signal-cli.git /build && \
    cd /build && git checkout $SIGNAL_CLI_COMMIT
WORKDIR /build
RUN ./gradlew installDist

FROM bbernhard/signal-cli-rest-api:0.97
# Copy built signal-cli over the bundled 0.13.23
COPY --from=builder /build/build/install/signal-cli /opt/signal-cli-master
# Copy Java 25 JRE (base image only has Java 21, but master needs 25)
COPY --from=builder /opt/java/openjdk /opt/java25
# Inject Linux ARM64 native JNI lib from base image's patched jar into master's jar
RUN python3 -c "\
import zipfile, glob; \
old_jar = glob.glob('/opt/signal-cli-0.13.23/lib/libsignal-client-*.jar')[0]; \
new_jar = glob.glob('/opt/signal-cli-master/lib/libsignal-client-*.jar')[0]; \
data = zipfile.ZipFile(old_jar).read('libsignal_jni.so'); \
z = zipfile.ZipFile(new_jar, 'a'); z.writestr('libsignal_jni.so', data); z.close(); \
print(f'Injected {len(data)} bytes from {old_jar} into {new_jar}')"
# Replace system Java 21 with Java 25 (supervisor doesn't inherit Docker ENV)
ENV JAVA_HOME=/opt/java25
RUN ln -sf /opt/java25/bin/java /usr/bin/java && \
    ln -sf /opt/signal-cli-master/bin/signal-cli /usr/bin/signal-cli
