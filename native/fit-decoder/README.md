# Native FIT decoder

This directory is a self-contained C++ project that streams Garmin FIT messages to the Node
application over newline-delimited JSON. It performs two constant-memory passes: the first emits
file metadata, and the second emits record or weight messages in batches of at most 250 messages
and 512 KiB. The decoder waits for a `continue` acknowledgement after every output message, so
database persistence provides backpressure to native decoding.

The project builds against Garmin's official
[FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk). Manifest-mode
[vcpkg](https://learn.microsoft.com/vcpkg/concepts/manifest-mode) installs the dependency from the
repository-owned `garmin-fit-sdk` overlay port. That port pins release `21.205.0` to its exact
upstream Git commit, builds it as a static library, and exposes a standard CMake package target.
Garmin's SDK remains subject to its own
[FIT SDK license](https://github.com/garmin/fit-cpp-sdk/blob/main/LICENSE.txt).

## Build

Install CMake 3.24 or newer, Ninja, and vcpkg. Set `VCPKG_ROOT` to the vcpkg checkout, then run:

```sh
cmake --preset release
cmake --build --preset release
```

The executable is written to `.build/fit-decoder/bin/dofek-fit-decoder` at the repository root.
[`CMakePresets.json`](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html) is the canonical
shared build configuration for local development, CI, and editor integrations. The preset selects
the [vcpkg CMake toolchain](https://learn.microsoft.com/vcpkg/users/buildsystems/cmake-integration),
and `vcpkg-configuration.json` registers the local overlay port and pins the upstream registry
baseline.

## Protocol

The executable accepts one FIT file path. It emits a `metadata` message, zero or more `records` or
`weights` batches, and one `end` message. The caller must write `continue` followed by a newline to
standard input after metadata and each batch. Any malformed file, oversized individual message,
missing acknowledgement, or write failure terminates the process with a nonzero exit status.
