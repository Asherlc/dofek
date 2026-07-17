cmake_minimum_required(VERSION 3.24)

project(dofek_fit_decoder VERSION 1.0.0 LANGUAGES CXX)

find_package(garmin-fit-sdk CONFIG REQUIRED)

add_library(fit-decoder-field-json STATIC src/field-json.cpp)
target_compile_features(fit-decoder-field-json PUBLIC cxx_std_17)
target_include_directories(fit-decoder-field-json PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(fit-decoder-field-json PUBLIC garmin-fit-sdk::garmin-fit-sdk)
set_target_properties(fit-decoder-field-json PROPERTIES CXX_EXTENSIONS OFF)

add_executable(dofek-fit-decoder src/fit-decoder.cpp)
target_compile_features(dofek-fit-decoder PRIVATE cxx_std_17)
target_link_libraries(dofek-fit-decoder PRIVATE fit-decoder-field-json)
set_target_properties(
  dofek-fit-decoder
  PROPERTIES
    CXX_EXTENSIONS OFF
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

install(TARGETS dofek-fit-decoder RUNTIME DESTINATION bin)

include(CTest)
if(BUILD_TESTING)
  add_executable(fit-decoder-field-json-test tests/FieldJsonTest.cpp)
  target_compile_features(fit-decoder-field-json-test PRIVATE cxx_std_17)
  target_link_libraries(fit-decoder-field-json-test PRIVATE fit-decoder-field-json)

  add_test(
    NAME fit-decoder-protocol
    COMMAND
      ${CMAKE_COMMAND}
      -DDECODER=$<TARGET_FILE:dofek-fit-decoder>
      -DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/../../src/fit/fixtures/test.fit
      -P ${CMAKE_CURRENT_SOURCE_DIR}/tests/VerifyProtocol.cmake
  )
  add_test(
    NAME fit-decoder-integer-precision
    COMMAND fit-decoder-field-json-test
  )
endif()
