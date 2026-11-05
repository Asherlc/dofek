FROM eclipse-temurin:25-jdk-alpine@sha256:425f0b733cb23843bd78dbe5552513976d0cf12b9722752c48a5161cf5cd2f32 AS offloader-build

RUN apk add --no-cache patch=2.8-r0
WORKDIR /src
ADD --checksum=sha256:687e2670dfb71ad10fd9972957de7426e4596a095b08781364950c4aa3fcafde \
    https://archive.apache.org/dist/pulsar/pulsar-5.0.1/apache-pulsar-5.0.1-src.tar.gz /tmp/pulsar-source.tar.gz
RUN tar -xzf /tmp/pulsar-source.tar.gz --strip-components=1 && rm /tmp/pulsar-source.tar.gz
COPY repeatable-offload-payload.patch /tmp/repeatable-offload-payload.patch
RUN patch -p1 < /tmp/repeatable-offload-payload.patch
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew :tiered-storage:tiered-storage-jcloud:test \
      --tests '*BlobStoreManagedLedgerOffloaderTest' \
      :tiered-storage:tiered-storage-jcloud:nar \
      :tiered-storage:tiered-storage-jcloud:checkstyleMain \
      :tiered-storage:tiered-storage-jcloud:checkstyleTest \
      -PtestRetryCount=0 -PtestMaxParallelForks=1 \
      --max-workers=2 --no-daemon \
      -Dorg.gradle.jvmargs='-Xmx1500m -Xss2m -XX:+UseG1GC' \
      > /tmp/offloader-build.log 2>&1; \
    result=$?; tail -n 30 /tmp/offloader-build.log; exit "$result"

FROM apachepulsar/pulsar:5.0.1@sha256:4507075d8c11b34629f3a0b41f48e3c659951e601538562ee0c088cd2c737ec0
COPY --from=offloader-build /src/tiered-storage/jcloud/build/libs/tiered-storage-jcloud-5.0.1.nar \
    /pulsar/offloaders/tiered-storage-jcloud-5.0.1.nar
