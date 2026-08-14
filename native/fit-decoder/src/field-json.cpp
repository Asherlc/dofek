#include "field-json.hpp"

#include <cmath>
#include <cstdint>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "fit_unicode.hpp"

namespace dofek::fit_decoder {
namespace {

constexpr std::int64_t kFitEpochUnixSeconds = 631065600;
constexpr double kSemicirclesPerDegree = 2147483648.0 / 180.0;

bool IsFitTimestampField(const fit::FieldBase& field) {
  if (field.GetType() != FIT_BASE_TYPE_UINT32) {
    return false;
  }
  const std::string name = field.GetName();
  return name == "timestamp" || name == "start_time" || name == "time_created";
}

std::string FitTimestampJson(const fit::FieldBase& field, FIT_UINT8 value_index) {
  const auto unix_seconds =
      static_cast<std::time_t>(field.GetUINT32Value(value_index) + kFitEpochUnixSeconds);
  std::tm utc_time{};
#if defined(_WIN32)
  if (gmtime_s(&utc_time, &unix_seconds) != 0) {
#else
  if (gmtime_r(&unix_seconds, &utc_time) == nullptr) {
#endif
    throw std::runtime_error("Unable to convert FIT timestamp");
  }
  char timestamp[32];
  if (std::strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%S.000Z", &utc_time) == 0) {
    throw std::runtime_error("Unable to format FIT timestamp");
  }
  return JsonString(timestamp);
}

std::optional<std::string> UnscaledIntegerJson(
    const fit::FieldBase& field,
    FIT_UINT8 value_index) {
  if (field.GetScale() != 1.0 || field.GetOffset() != 0.0) {
    return std::nullopt;
  }
  switch (field.GetType()) {
    case FIT_BASE_TYPE_ENUM:
      return std::to_string(static_cast<unsigned int>(field.GetENUMValue(value_index)));
    case FIT_BASE_TYPE_BYTE:
      return std::to_string(static_cast<unsigned int>(field.GetBYTEValue(value_index)));
    case FIT_BASE_TYPE_SINT8:
      return std::to_string(static_cast<int>(field.GetSINT8Value(value_index)));
    case FIT_BASE_TYPE_UINT8:
      return std::to_string(static_cast<unsigned int>(field.GetUINT8Value(value_index)));
    case FIT_BASE_TYPE_UINT8Z:
      return std::to_string(static_cast<unsigned int>(field.GetUINT8ZValue(value_index)));
    case FIT_BASE_TYPE_SINT16:
      return std::to_string(static_cast<int>(field.GetSINT16Value(value_index)));
    case FIT_BASE_TYPE_UINT16:
      return std::to_string(static_cast<unsigned int>(field.GetUINT16Value(value_index)));
    case FIT_BASE_TYPE_UINT16Z:
      return std::to_string(static_cast<unsigned int>(field.GetUINT16ZValue(value_index)));
    case FIT_BASE_TYPE_SINT32:
      return std::to_string(field.GetSINT32Value(value_index));
    case FIT_BASE_TYPE_UINT32:
      return std::to_string(field.GetUINT32Value(value_index));
    case FIT_BASE_TYPE_UINT32Z:
      return std::to_string(field.GetUINT32ZValue(value_index));
    case FIT_BASE_TYPE_SINT64:
      return JsonString(std::to_string(field.GetSINT64Value(value_index)));
    case FIT_BASE_TYPE_UINT64:
      return JsonString(std::to_string(field.GetUINT64Value(value_index)));
    case FIT_BASE_TYPE_UINT64Z:
      return JsonString(std::to_string(field.GetUINT64ZValue(value_index)));
    default:
      return std::nullopt;
  }
}

}  // namespace

std::string JsonString(const std::string& value) {
  std::ostringstream output;
  output << '"';
  for (const unsigned char character : value) {
    switch (character) {
      case '"':
        output << "\\\"";
        break;
      case '\\':
        output << "\\\\";
        break;
      case '\b':
        output << "\\b";
        break;
      case '\f':
        output << "\\f";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (character < 0x20) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<int>(character) << std::dec << std::setfill(' ');
        } else {
          output << character;
        }
    }
  }
  output << '"';
  return output.str();
}

std::string JsonNumber(double value) {
  if (!std::isfinite(value)) {
    throw std::runtime_error("FIT field contains a non-finite number");
  }
  std::ostringstream output;
  output << std::setprecision(17) << value;
  return output.str();
}

std::optional<std::string> JsonFieldValue(
    const fit::FieldBase& field,
    FIT_UINT8 value_index) {
  if (!field.IsValueValid(value_index)) {
    return std::nullopt;
  }
  const std::string field_name = field.GetName();
  if (IsFitTimestampField(field)) {
    return FitTimestampJson(field, value_index);
  }
  if (field.GetType() == FIT_BASE_TYPE_STRING) {
    return JsonString(fit::Unicode::Encode_BaseToUTF8(field.GetSTRINGValue(value_index)));
  }
  if (field_name == "left_right_balance") {
    const auto encoded_balance = static_cast<unsigned int>(field.GetRawValue(value_index));
    return std::string("{\"value\":") + JsonNumber(encoded_balance & 0x7fU) +
           ",\"right\":" + ((encoded_balance & 0x80U) == 0 ? "false" : "true") + "}";
  }
  const double value = field.GetFLOAT64Value(value_index);
  if (!std::isfinite(value)) {
    const std::optional<std::string> integer_value = UnscaledIntegerJson(field, value_index);
    return integer_value;
  }
  if (field.GetUnits() == "semicircles") {
    return JsonNumber(value / kSemicirclesPerDegree);
  }
  const std::optional<std::string> integer_value = UnscaledIntegerJson(field, value_index);
  if (integer_value.has_value()) {
    return integer_value;
  }
  return JsonNumber(value);
}

std::optional<std::string> JsonField(const fit::FieldBase& field) {
  std::vector<std::string> values;
  values.reserve(field.GetNumValues());
  for (FIT_UINT8 value_index = 0; value_index < field.GetNumValues(); ++value_index) {
    const std::optional<std::string> value = JsonFieldValue(field, value_index);
    if (value.has_value()) {
      values.push_back(*value);
    }
  }
  if (values.empty()) {
    return std::nullopt;
  }
  if (values.size() == 1) {
    return values.front();
  }
  std::ostringstream output;
  output << '[';
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) {
      output << ',';
    }
    output << values[index];
  }
  output << ']';
  return output.str();
}

}  // namespace dofek::fit_decoder
