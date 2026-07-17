cmake_minimum_required(VERSION 3.24)

project(garmin_fit_sdk VERSION 21.205.0 LANGUAGES CXX)

include(cmake/GenerateFitEnumNames.cmake)
generate_fit_enum_names(
  "${CMAKE_CURRENT_SOURCE_DIR}/src/fit_profile.hpp"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/fit_profile_enum_names.hpp"
)

set(
  GARMIN_FIT_SOURCES
  src/fit_developer_field.cpp
  src/fit_developer_field_definition.cpp
  src/fit_developer_field_description.cpp
  src/fit_field_base.cpp
  src/fit.cpp
  src/fit_accumulated_field.cpp
  src/fit_accumulator.cpp
  src/fit_buffered_mesg_broadcaster.cpp
  src/fit_buffered_record_mesg_broadcaster.cpp
  src/fit_crc.cpp
  src/fit_decode.cpp
  src/fit_field.cpp
  src/fit_field_definition.cpp
  src/fit_mesg.cpp
  src/fit_mesg_broadcaster.cpp
  src/fit_mesg_definition.cpp
  src/fit_mesg_with_event_broadcaster.cpp
  src/fit_profile.cpp
  src/fit_unicode.cpp
)

add_library(garmin-fit-sdk STATIC ${GARMIN_FIT_SOURCES})
target_compile_features(garmin-fit-sdk PUBLIC cxx_std_17)
target_include_directories(
  garmin-fit-sdk
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>
    $<BUILD_INTERFACE:${CMAKE_CURRENT_BINARY_DIR}/generated>
    $<INSTALL_INTERFACE:include/garmin-fit-sdk>
)
set_target_properties(garmin-fit-sdk PROPERTIES CXX_EXTENSIONS OFF)

install(
  TARGETS garmin-fit-sdk
  EXPORT garmin-fit-sdk-targets
  ARCHIVE DESTINATION lib
)
install(
  DIRECTORY src/
  DESTINATION include/garmin-fit-sdk
  FILES_MATCHING
  PATTERN "*.hpp"
)
install(
  FILES "${CMAKE_CURRENT_BINARY_DIR}/generated/fit_profile_enum_names.hpp"
  DESTINATION include/garmin-fit-sdk
)
install(
  EXPORT garmin-fit-sdk-targets
  FILE garmin-fit-sdk-config.cmake
  NAMESPACE garmin-fit-sdk::
  DESTINATION share/garmin-fit-sdk
)
