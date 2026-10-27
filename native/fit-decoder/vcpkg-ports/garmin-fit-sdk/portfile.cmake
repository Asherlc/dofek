set(VCPKG_LIBRARY_LINKAGE static)

vcpkg_from_git(
  OUT_SOURCE_PATH SOURCE_PATH
  URL https://github.com/garmin/fit-cpp-sdk.git
  REF 1212b0790b225b36180f925c9ee6d72ed61f7b6c
  HEAD_REF main
)

file(
  COPY
    "${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt"
    "${CMAKE_CURRENT_LIST_DIR}/cmake"
  DESTINATION "${SOURCE_PATH}"
)

vcpkg_cmake_configure(SOURCE_PATH "${SOURCE_PATH}")
vcpkg_cmake_install()
vcpkg_cmake_config_fixup(CONFIG_PATH share/garmin-fit-sdk)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE.txt")
