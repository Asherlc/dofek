set(fixture "${CMAKE_CURRENT_BINARY_DIR}/workout.fit")
execute_process(COMMAND "${FIXTURE_WRITER}" "${fixture}" workout RESULT_VARIABLE fixture_result)
if(NOT fixture_result EQUAL 0)
  message(FATAL_ERROR "Unable to write workout fixture")
endif()
set(acknowledgement_file "${CMAKE_CURRENT_BINARY_DIR}/workout-acknowledgements.txt")
file(WRITE "${acknowledgement_file}" "continue\ncontinue\ncontinue\ncontinue\ncontinue\ncontinue\n")
execute_process(
  COMMAND "${DECODER}" "${fixture}"
  INPUT_FILE "${acknowledgement_file}"
  OUTPUT_VARIABLE protocol_output
  ERROR_VARIABLE decoder_error
  RESULT_VARIABLE decoder_result
)
if(NOT decoder_result EQUAL 0)
  message(FATAL_ERROR "FIT decoder failed (${decoder_result}): ${decoder_error}")
endif()

string(REPLACE "\n" ";" protocol_lines "${protocol_output}")
set(batch_types "")
foreach(line IN LISTS protocol_lines)
  if(line STREQUAL "")
    continue()
  endif()
  string(JSON type GET "${line}" type)
  list(APPEND batch_types "${type}")
  if(type STREQUAL "metadata")
    string(JSON session_count GET "${line}" sessionMessageCount)
    string(JSON workout_count GET "${line}" workoutMessageCount)
    if(NOT session_count EQUAL 1 OR NOT workout_count EQUAL 1)
      message(FATAL_ERROR "Expected one session and one workout, got ${session_count}/${workout_count}")
    endif()
    string(JSON declared_steps GET "${line}" workoutStepCount)
    if(NOT declared_steps EQUAL 2)
      message(FATAL_ERROR "Expected the Workout header's two declared steps, got ${declared_steps}")
    endif()
  elseif(type STREQUAL "workoutSteps")
    string(JSON step_count LENGTH "${line}" messages)
    if(NOT step_count EQUAL 2)
      message(FATAL_ERROR "Expected two workout steps, got ${step_count}")
    endif()
    string(JSON first_duration GET "${line}" messages 0 duration_value)
    string(JSON first_low GET "${line}" messages 0 custom_target_value_low)
    string(JSON first_high GET "${line}" messages 0 custom_target_value_high)
    string(JSON second_low GET "${line}" messages 1 custom_target_value_low)
    string(JSON second_high GET "${line}" messages 1 custom_target_value_high)
    if(NOT first_duration EQUAL 180000 OR NOT first_low EQUAL 1250 OR NOT first_high EQUAL 1265
       OR NOT second_low EQUAL 1260 OR NOT second_high EQUAL 1260)
      message(FATAL_ERROR "Workout step raw values were not retained: ${line}")
    endif()
  elseif(type STREQUAL "laps")
    string(JSON lap_count LENGTH "${line}" messages)
    if(NOT lap_count EQUAL 3)
      message(FATAL_ERROR "Expected three laps, got ${lap_count}")
    endif()
    string(JSON step_0 GET "${line}" messages 0 wkt_step_index)
    string(JSON step_1 GET "${line}" messages 1 wkt_step_index)
    string(JSON step_2 GET "${line}" messages 2 wkt_step_index)
    string(JSON timer_1 GET "${line}" messages 1 total_timer_time)
    string(JSON elapsed_1 GET "${line}" messages 1 total_elapsed_time)
    if(NOT step_0 EQUAL 0 OR NOT step_1 EQUAL 0 OR NOT step_2 EQUAL 1
       OR NOT timer_1 EQUAL 134 OR NOT elapsed_1 EQUAL 145)
      message(FATAL_ERROR "Lap raw values were not retained: ${line}")
    endif()
  elseif(type STREQUAL "end")
    string(JSON message_count GET "${line}" messageCount)
    if(NOT message_count EQUAL 10)
      message(FATAL_ERROR "Expected 10 streamed messages, got ${message_count}")
    endif()
  endif()
endforeach()
if(NOT batch_types STREQUAL "metadata;workoutSteps;records;laps;end")
  message(FATAL_ERROR "Unexpected workout batch order: ${batch_types}")
endif()

# An activity without an embedded workout streams neither laps nor workout steps.
set(plain_fixture "${CMAKE_CURRENT_BINARY_DIR}/plain-laps.fit")
execute_process(COMMAND "${FIXTURE_WRITER}" "${plain_fixture}" plain-laps RESULT_VARIABLE plain_result)
if(NOT plain_result EQUAL 0)
  message(FATAL_ERROR "Unable to write plain-laps fixture")
endif()
execute_process(
  COMMAND "${DECODER}" "${plain_fixture}"
  INPUT_FILE "${acknowledgement_file}"
  OUTPUT_VARIABLE plain_output
  ERROR_VARIABLE plain_error
  RESULT_VARIABLE plain_result
)
if(NOT plain_result EQUAL 0)
  message(FATAL_ERROR "FIT decoder failed on plain laps (${plain_result}): ${plain_error}")
endif()
if(plain_output MATCHES "\"type\":\"(laps|workoutSteps)\"")
  message(FATAL_ERROR "Laps without an embedded workout must not be streamed: ${plain_output}")
endif()
string(FIND "${plain_output}" "\"workoutMessageCount\":0" plain_workout_count)
if(plain_workout_count EQUAL -1)
  message(FATAL_ERROR "Expected zero workout messages in plain-laps metadata")
endif()

function(decode_fixture mode output_variable)
  set(path "${CMAKE_CURRENT_BINARY_DIR}/${mode}.fit")
  execute_process(COMMAND "${FIXTURE_WRITER}" "${path}" "${mode}" RESULT_VARIABLE write_result)
  if(NOT write_result EQUAL 0)
    message(FATAL_ERROR "Unable to write ${mode} fixture")
  endif()
  execute_process(
    COMMAND "${DECODER}" "${path}"
    INPUT_FILE "${acknowledgement_file}"
    OUTPUT_VARIABLE decoded
    ERROR_VARIABLE decode_error
    RESULT_VARIABLE decode_result
  )
  if(NOT decode_result EQUAL 0)
    message(FATAL_ERROR "FIT decoder failed on ${mode} (${decode_result}): ${decode_error}")
  endif()
  set(${output_variable} "${decoded}" PARENT_SCOPE)
endfunction()

# A Workout header without num_valid_steps reports a null declared step count.
decode_fixture(workout-no-count no_count_output)
if(NOT no_count_output MATCHES "\"workoutStepCount\":null")
  message(FATAL_ERROR "A missing num_valid_steps must be reported as null: ${no_count_output}")
endif()

# Chained segments: an activity segment with lap links followed by a standalone Workout file
# aggregates one session and one workout in metadata, but must not stream a cross-segment link.
decode_fixture(workout-chained chained_output)
if(NOT chained_output MATCHES "\"workoutMessageCount\":1")
  message(FATAL_ERROR "Chained fixture should aggregate one workout message: ${chained_output}")
endif()
if(chained_output MATCHES "\"type\":\"(laps|workoutSteps)\"")
  message(FATAL_ERROR "Chained FIT segments must not stream lap or workout step batches: ${chained_output}")
endif()
if(NOT chained_output MATCHES "\"type\":\"records\"")
  message(FATAL_ERROR "Chained FIT records must remain streamed: ${chained_output}")
endif()
