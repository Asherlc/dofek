#include <cstdint>
#include <iostream>
#include <limits>
#include <string>

#include "field-json.hpp"

namespace {

class TestField final : public fit::FieldBase {
 public:
  explicit TestField(FIT_UINT8 type) : type_(type) {}

  FIT_BOOL GetIsAccumulated() const override { return FIT_FALSE; }
  FIT_BOOL IsValid() const override { return FIT_TRUE; }
  FIT_UINT8 GetNum() const override { return 1; }
  std::string GetName() const override { return "precise_integer"; }
  FIT_UINT8 GetType() const override { return type_; }
  std::string GetUnits() const override { return ""; }
  FIT_FLOAT64 GetScale() const override { return 1; }
  FIT_FLOAT64 GetOffset() const override { return 0; }
  const fit::Profile::SUBFIELD* GetSubField(FIT_UINT16) const override { return nullptr; }
  FIT_UINT16 GetNumSubFields() const override { return 0; }
  const fit::Profile::FIELD_COMPONENT* GetComponent(FIT_UINT16) const override { return nullptr; }
  FIT_UINT16 GetNumComponents() const override { return 0; }

 private:
  FIT_UINT8 type_;
};

}  // namespace

int main() {
  TestField field(FIT_BASE_TYPE_UINT64);
  const std::uint64_t precise_integer = std::numeric_limits<std::uint64_t>::max() - 1U;
  field.Read(&precise_integer, sizeof(precise_integer));
  const std::optional<std::string> json = dofek::fit_decoder::JsonFieldValue(field, 0);
  if (json != "\"18446744073709551614\"") {
    std::cerr << "Expected lossless uint64 JSON, received " << json.value_or("null") << '\n';
    return 1;
  }
  return 0;
}
