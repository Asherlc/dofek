# Native FIT Decoder

Always read the repository root [`README.md`](../../README.md) first. Then read this package's
`README.md` before changing it; it defines the build, dependency, protocol, and memory-bound
contracts.

## Tooling

- Keep C++ builds on the repository's CMake presets and Ninja workflow; presets are the shared
  configuration intended for command-line and IDE use
  ([CMake presets documentation](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html)).
- Manage C++ dependencies through the checked-in vcpkg manifest and overlay port
  ([vcpkg manifest-mode documentation](https://learn.microsoft.com/vcpkg/concepts/manifest-mode)).
- Generate FIT enum labels from Garmin's pinned `fit_profile.hpp`; do not maintain a second
  handwritten code list
  ([Garmin FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk)).

## Validation

- Build with `cmake --preset release` and `cmake --build --preset release`.
- Run the native protocol suite with `ctest --preset release`.
- Preserve the protocol's 512 KiB message limit, 250-message batch limit, capped metadata
  cardinality, and acknowledgement backpressure. Any change to those contracts must update both
  `README.md` and `tests/VerifyProtocol.cmake`.
