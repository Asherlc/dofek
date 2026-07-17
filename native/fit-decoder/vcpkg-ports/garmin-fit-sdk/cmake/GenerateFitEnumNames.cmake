function(generate_fit_enum_names input_file output_file)
  file(
    STRINGS "${input_file}"
    profile_definitions
    REGEX "^#define[ \t]+FIT_(FILE|SPORT|SUB_SPORT)_[A-Z0-9_]+"
  )

  set(file_entries "")
  set(sport_entries "")
  set(sub_sport_entries "")
  foreach(profile_definition IN LISTS profile_definitions)
    if(
      profile_definition
      MATCHES
      "^#define[ \t]+(FIT_FILE_([A-Z0-9_]+))[ \t]+\\(\\(FIT_FILE\\)[0-9]+\\)"
    )
      set(profile_constant "${CMAKE_MATCH_1}")
      string(TOLOWER "${CMAKE_MATCH_2}" profile_name)
      string(
        APPEND file_entries
        "    {${profile_constant}, \"${profile_name}\"},\n"
      )
    elseif(
      profile_definition
      MATCHES
      "^#define[ \t]+(FIT_SPORT_([A-Z0-9_]+))[ \t]+\\(\\(FIT_SPORT\\)[0-9]+\\)"
    )
      set(profile_constant "${CMAKE_MATCH_1}")
      string(TOLOWER "${CMAKE_MATCH_2}" profile_name)
      string(
        APPEND sport_entries
        "    {${profile_constant}, \"${profile_name}\"},\n"
      )
    elseif(
      profile_definition
      MATCHES
      "^#define[ \t]+(FIT_SUB_SPORT_([A-Z0-9_]+))[ \t]+\\(\\(FIT_SUB_SPORT\\)[0-9]+\\)"
    )
      set(profile_constant "${CMAKE_MATCH_1}")
      string(TOLOWER "${CMAKE_MATCH_2}" profile_name)
      string(
        APPEND sub_sport_entries
        "    {${profile_constant}, \"${profile_name}\"},\n"
      )
    endif()
  endforeach()

  if(file_entries STREQUAL "" OR sport_entries STREQUAL "" OR sub_sport_entries STREQUAL "")
    message(FATAL_ERROR "Unable to generate FIT enum names from ${input_file}")
  endif()

  get_filename_component(output_directory "${output_file}" DIRECTORY)
  file(MAKE_DIRECTORY "${output_directory}")
  file(
    WRITE "${output_file}"
    "#pragma once\n\n"
    "#include <string_view>\n"
    "#include <utility>\n\n"
    "#include \"fit_profile.hpp\"\n\n"
    "namespace dofek::fit_profile_names {\n\n"
    "inline constexpr std::pair<FIT_FILE, std::string_view> kFileNames[] = {\n"
    "${file_entries}"
    "};\n\n"
    "inline constexpr std::pair<FIT_SPORT, std::string_view> kSportNames[] = {\n"
    "${sport_entries}"
    "};\n\n"
    "inline constexpr std::pair<FIT_SUB_SPORT, std::string_view> kSubSportNames[] = {\n"
    "${sub_sport_entries}"
    "};\n\n"
    "inline std::string_view FileName(FIT_FILE file) {\n"
    "  for (const auto& entry : kFileNames) {\n"
    "    if (entry.first == file) {\n"
    "      return entry.second;\n"
    "    }\n"
    "  }\n"
    "  return {};\n"
    "}\n\n"
    "inline std::string_view SportName(FIT_SPORT sport) {\n"
    "  for (const auto& entry : kSportNames) {\n"
    "    if (entry.first == sport) {\n"
    "      return entry.second;\n"
    "    }\n"
    "  }\n"
    "  return {};\n"
    "}\n\n"
    "inline std::string_view SubSportName(FIT_SUB_SPORT sub_sport) {\n"
    "  for (const auto& entry : kSubSportNames) {\n"
    "    if (entry.first == sub_sport) {\n"
    "      return entry.second;\n"
    "    }\n"
    "  }\n"
    "  return {};\n"
    "}\n\n"
    "}  // namespace dofek::fit_profile_names\n"
  )
endfunction()
