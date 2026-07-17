set(acknowledgements "")
foreach(_ RANGE 1 1000)
  string(APPEND acknowledgements "continue\n")
endforeach()
set(acknowledgement_file "${CMAKE_CURRENT_BINARY_DIR}/fit-decoder-acknowledgements.txt")
file(WRITE "${acknowledgement_file}" "${acknowledgements}")

execute_process(
  COMMAND "${DECODER}" "${FIXTURE}"
  INPUT_FILE "${acknowledgement_file}"
  OUTPUT_VARIABLE protocol_output
  ERROR_VARIABLE decoder_error
  RESULT_VARIABLE decoder_result
)
if(NOT decoder_result EQUAL 0)
  message(FATAL_ERROR "FIT decoder failed (${decoder_result}): ${decoder_error}")
endif()

string(REPLACE "\n" ";" protocol_lines "${protocol_output}")
set(metadata_seen FALSE)
set(end_seen FALSE)
set(streamed_message_count 0)
set(reported_message_count 0)
foreach(protocol_line IN LISTS protocol_lines)
  if(protocol_line STREQUAL "")
    continue()
  endif()
  string(LENGTH "${protocol_line}" protocol_line_bytes)
  math(EXPR protocol_message_bytes "${protocol_line_bytes} + 1")
  if(protocol_message_bytes GREATER 524288)
    message(FATAL_ERROR "FIT decoder emitted a ${protocol_message_bytes}-byte protocol message")
  endif()
  string(JSON message_type GET "${protocol_line}" type)
  if(message_type STREQUAL "metadata")
    string(JSON file_type_name GET "${protocol_line}" fileTypeName)
    if(NOT file_type_name STREQUAL "activity")
      message(FATAL_ERROR "Expected activity file metadata, received ${file_type_name}")
    endif()
    string(JSON field_occurrence_count LENGTH "${protocol_line}" fieldOccurrences)
    if(field_occurrence_count LESS_EQUAL 0)
      message(FATAL_ERROR "Expected bounded field occurrence metadata")
    endif()
    string(JSON sport_name GET "${protocol_line}" sportName)
    if(NOT sport_name STREQUAL "cycling")
      message(FATAL_ERROR "Expected cycling metadata, received ${sport_name}")
    endif()
    set(metadata_seen TRUE)
  elseif(message_type STREQUAL "records")
    string(JSON batch_size LENGTH "${protocol_line}" messages)
    if(batch_size GREATER 250)
      message(FATAL_ERROR "FIT decoder emitted ${batch_size} records in one batch")
    endif()
    math(EXPR streamed_message_count "${streamed_message_count} + ${batch_size}")
  elseif(message_type STREQUAL "end")
    string(JSON reported_message_count GET "${protocol_line}" messageCount)
    set(end_seen TRUE)
  else()
    message(FATAL_ERROR "Unexpected FIT decoder message type: ${message_type}")
  endif()
endforeach()

if(NOT metadata_seen OR NOT end_seen)
  message(FATAL_ERROR "FIT decoder protocol did not include metadata and end messages")
endif()
if(streamed_message_count LESS_EQUAL 250)
  message(FATAL_ERROR "FIT decoder fixture did not exercise multiple batches")
endif()
if(NOT streamed_message_count EQUAL reported_message_count)
  message(
    FATAL_ERROR
    "FIT decoder streamed ${streamed_message_count} messages but reported ${reported_message_count}"
  )
endif()

file(SIZE "${FIXTURE}" fixture_size)
math(EXPR truncated_size "${fixture_size} - 16")
file(READ "${FIXTURE}" truncated_fixture_content LIMIT "${truncated_size}")
set(truncated_fixture "${CMAKE_CURRENT_BINARY_DIR}/truncated.fit")
file(WRITE "${truncated_fixture}" "${truncated_fixture_content}")
execute_process(
  COMMAND "${DECODER}" "${truncated_fixture}"
  INPUT_FILE "${acknowledgement_file}"
  OUTPUT_VARIABLE truncated_output
  ERROR_VARIABLE truncated_error
  RESULT_VARIABLE truncated_result
)
if(truncated_result EQUAL 0)
  message(FATAL_ERROR "FIT decoder accepted a truncated file")
endif()
if(NOT truncated_output STREQUAL "")
  message(FATAL_ERROR "FIT decoder emitted protocol data before rejecting a truncated file")
endif()
