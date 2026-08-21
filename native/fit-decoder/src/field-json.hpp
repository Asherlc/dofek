#pragma once

#include <optional>
#include <string>

#include "fit_field_base.hpp"

namespace dofek::fit_decoder {

std::string JsonString(const std::string& value);
std::string JsonNumber(double value);
std::optional<std::string> JsonFieldValue(const fit::FieldBase& field, FIT_UINT8 value_index);
std::optional<std::string> JsonField(const fit::FieldBase& field);

}  // namespace dofek::fit_decoder
