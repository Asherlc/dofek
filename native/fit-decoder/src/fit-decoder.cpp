#include <algorithm>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "fit_decode.hpp"
#include "fit_file_id_mesg.hpp"
#include "fit_mesg_broadcaster.hpp"
#include "fit_profile.hpp"
#include "fit_profile_enum_names.hpp"
#include "fit_session_mesg.hpp"
#include "field-json.hpp"

namespace {

constexpr std::size_t kMaximumBatchMessages = 250;
constexpr std::size_t kMaximumBatchBytes = 512 * 1024;
constexpr std::size_t kMaximumFieldOccurrenceKeys = 4096;

using dofek::fit_decoder::JsonField;
using dofek::fit_decoder::JsonString;

bool HasValidFieldValue(const fit::FieldBase& field) {
  for (FIT_UINT8 value_index = 0; value_index < field.GetNumValues(); ++value_index) {
    if (field.IsValueValid(value_index)) {
      return true;
    }
  }
  return false;
}

std::string UniqueFieldName(
    const fit::FieldBase& field,
    std::unordered_set<std::string>& used_names,
    bool developer_field) {
  std::string name = field.GetName();
  if (name.empty()) {
    name = developer_field ? "developer_field" : "field";
  }
  if (used_names.insert(name).second) {
    return name;
  }
  const std::string suffix = developer_field ? "_developer_" : "_field_";
  name += suffix + std::to_string(field.GetNum());
  std::size_t duplicate_index = 2;
  while (!used_names.insert(name).second) {
    name += "_" + std::to_string(duplicate_index++);
  }
  return name;
}

std::string JsonMessage(const fit::Mesg& message) {
  std::ostringstream output;
  output << '{';
  bool first_field = true;
  std::unordered_set<std::string> used_names;
  const auto append_field = [&](const fit::FieldBase& field, bool developer_field) {
    const std::optional<std::string> value = JsonField(field);
    if (!value.has_value()) {
      return;
    }
    if (!first_field) {
      output << ',';
    }
    first_field = false;
    output << JsonString(UniqueFieldName(field, used_names, developer_field)) << ':' << *value;
  };
  for (FIT_UINT16 index = 0; index < message.GetNumFields(); ++index) {
    const fit::Field* field = message.GetFieldByIndex(index);
    if (field != nullptr) {
      append_field(*field, false);
    }
  }
  for (const fit::DeveloperField& field : message.GetDeveloperFields()) {
    append_field(field, true);
  }
  output << '}';
  return output.str();
}

void DecodeWithListener(const std::string& file_path, fit::Decode& decoder, fit::MesgListener& listener) {
  std::ifstream file(file_path, std::ios::in | std::ios::binary);
  if (!file.is_open()) {
    throw std::runtime_error("Unable to open FIT file");
  }
  fit::MesgBroadcaster broadcaster;
  broadcaster.AddListener(listener);
  if (!decoder.Read(file, broadcaster, broadcaster)) {
    throw std::runtime_error("FIT decoder stopped before reaching the end of the file");
  }
}

class MetadataListener final : public fit::MesgListener {
 public:
  void OnMesg(fit::Mesg& message) override {
    RecordFieldOccurrences(message);
    switch (message.GetNum()) {
      case FIT_MESG_NUM_FILE_ID: {
        const fit::FileIdMesg file_id(message);
        if (!file_type_.has_value() && file_id.IsTypeValid()) {
          file_type_ = file_id.GetType();
          const std::string_view file_type_name =
              dofek::fit_profile_names::FileName(file_id.GetType());
          if (!file_type_name.empty()) {
            file_type_name_ = file_type_name;
          }
        }
        break;
      }
      case FIT_MESG_NUM_SESSION: {
        if (!session_json_.has_value()) {
          const fit::SessionMesg session(message);
          session_json_ = JsonMessage(message);
          if (session.IsSportValid()) {
            const std::string_view sport_name =
                dofek::fit_profile_names::SportName(session.GetSport());
            if (!sport_name.empty()) {
              sport_name_ = sport_name;
            }
          }
          if (session.IsSubSportValid()) {
            const std::string_view sub_sport_name =
                dofek::fit_profile_names::SubSportName(session.GetSubSport());
            if (!sub_sport_name.empty()) {
              sub_sport_name_ = sub_sport_name;
            }
          }
        }
        break;
      }
      case FIT_MESG_NUM_WEIGHT_SCALE:
        has_weight_messages_ = true;
        break;
      default:
        break;
    }
  }

  std::optional<unsigned int> FileType() const { return file_type_; }
  const std::optional<std::string>& FileTypeName() const { return file_type_name_; }
  bool HasWeightMessages() const { return has_weight_messages_; }
  const std::optional<std::string>& SessionJson() const { return session_json_; }
  const std::optional<std::string>& SportName() const { return sport_name_; }
  const std::optional<std::string>& SubSportName() const { return sub_sport_name_; }
  const std::unordered_map<std::string, std::unordered_map<std::string, std::size_t>>&
  FieldOccurrences() const {
    return field_occurrences_;
  }

 private:
  void RecordFieldOccurrences(fit::Mesg& message) {
    std::string message_name = message.GetName();
    if (message_name.empty()) {
      message_name = "message_" + std::to_string(message.GetNum());
    }
    std::unordered_set<std::string> used_names;
    const auto record_field = [&](const fit::FieldBase& field, bool developer_field) {
      if (!HasValidFieldValue(field)) {
        return;
      }
      const std::string field_name = UniqueFieldName(field, used_names, developer_field);
      auto& message_fields = field_occurrences_[message_name];
      const auto existing = message_fields.find(field_name);
      if (existing != message_fields.end()) {
        ++existing->second;
        return;
      }
      if (field_occurrence_key_count_ == kMaximumFieldOccurrenceKeys) {
        throw std::runtime_error("FIT file exceeds the field occurrence metadata limit");
      }
      message_fields.emplace(field_name, 1);
      ++field_occurrence_key_count_;
    };
    for (FIT_UINT16 index = 0; index < message.GetNumFields(); ++index) {
      const fit::Field* field = message.GetFieldByIndex(index);
      if (field != nullptr) {
        record_field(*field, false);
      }
    }
    for (const fit::DeveloperField& field : message.GetDeveloperFields()) {
      record_field(field, true);
    }
  }

  std::optional<unsigned int> file_type_;
  std::optional<std::string> file_type_name_;
  bool has_weight_messages_ = false;
  std::optional<std::string> session_json_;
  std::optional<std::string> sport_name_;
  std::optional<std::string> sub_sport_name_;
  std::unordered_map<std::string, std::unordered_map<std::string, std::size_t>>
      field_occurrences_;
  std::size_t field_occurrence_key_count_ = 0;
};

void WaitForContinue();
void WriteBatch(const std::string& type, const std::vector<std::string>& messages);

std::size_t BatchEnvelopeBytes(const std::string& type) {
  return std::string("{\"type\":").size() + JsonString(type).size() +
         std::string(",\"messages\":[]}").size() + 1;
}

class BatchListener final : public fit::MesgListener {
 public:
  BatchListener(FIT_UINT16 target_message_number, std::string batch_type)
      : target_message_number_(target_message_number), batch_type_(std::move(batch_type)) {}

  void OnMesg(fit::Mesg& message) override {
    if (message.GetNum() != target_message_number_) {
      return;
    }
    std::string json = JsonMessage(message);
    if (BatchEnvelopeBytes(batch_type_) + json.size() > kMaximumBatchBytes) {
      throw std::runtime_error("One decoded FIT message exceeds the 512 KiB batch limit");
    }
    const std::size_t separator_bytes = messages_.empty() ? 0 : 1;
    if (!messages_.empty() &&
        BatchEnvelopeBytes(batch_type_) + batch_bytes_ + separator_bytes + json.size() >
            kMaximumBatchBytes) {
      FlushBatch();
    }
    batch_bytes_ += (messages_.empty() ? 0 : 1) + json.size();
    messages_.push_back(std::move(json));
    ++message_count_;
    if (messages_.size() == kMaximumBatchMessages) {
      FlushBatch();
    }
  }

  std::size_t MessageCount() const { return message_count_; }

  void FlushBatch() {
    if (messages_.empty()) {
      return;
    }
    WriteBatch(batch_type_, messages_);
    WaitForContinue();
    messages_.clear();
    batch_bytes_ = 0;
  }

 private:
  FIT_UINT16 target_message_number_;
  std::string batch_type_;
  std::vector<std::string> messages_;
  std::size_t batch_bytes_ = 0;
  std::size_t message_count_ = 0;
};

void WaitForContinue() {
  std::string command;
  if (!std::getline(std::cin, command) || command != "continue") {
    throw std::runtime_error("FIT decoder did not receive the expected continue acknowledgement");
  }
}

void WriteMetadata(const MetadataListener& metadata) {
  std::ostringstream output;
  output << "{\"type\":\"metadata\",\"fileType\":";
  if (metadata.FileType().has_value()) {
    output << *metadata.FileType();
  } else {
    output << "null";
  }
  output << ",\"fileTypeName\":";
  if (metadata.FileTypeName().has_value()) {
    output << JsonString(*metadata.FileTypeName());
  } else {
    output << "null";
  }
  output << ",\"hasWeightMessages\":"
         << (metadata.HasWeightMessages() ? "true" : "false") << ",\"session\":";
  if (metadata.SessionJson().has_value()) {
    output << *metadata.SessionJson();
  } else {
    output << "null";
  }
  output << ",\"sportName\":";
  if (metadata.SportName().has_value()) {
    output << JsonString(*metadata.SportName());
  } else {
    output << "null";
  }
  output << ",\"subSportName\":";
  if (metadata.SubSportName().has_value()) {
    output << JsonString(*metadata.SubSportName());
  } else {
    output << "null";
  }
  std::vector<std::tuple<std::string, std::string, std::size_t>> field_occurrences;
  for (const auto& [message_type, message_fields] : metadata.FieldOccurrences()) {
    for (const auto& [field, occurrences] : message_fields) {
      field_occurrences.emplace_back(message_type, field, occurrences);
    }
  }
  std::sort(field_occurrences.begin(), field_occurrences.end());
  output << ",\"fieldOccurrences\":[";
  for (std::size_t index = 0; index < field_occurrences.size(); ++index) {
    if (index > 0) {
      output << ',';
    }
    const auto& [message_type, field, occurrences] = field_occurrences[index];
    output << "{\"messageType\":" << JsonString(message_type)
           << ",\"field\":" << JsonString(field)
           << ",\"occurrences\":" << occurrences << '}';
  }
  output << "]}\n";
  const std::string protocol_message = output.str();
  if (protocol_message.size() > kMaximumBatchBytes) {
    throw std::runtime_error("FIT metadata exceeds the 512 KiB protocol limit");
  }
  std::cout << protocol_message << std::flush;
}

void WriteBatch(const std::string& type, const std::vector<std::string>& messages) {
  std::cout << "{\"type\":" << JsonString(type) << ",\"messages\":[";
  for (std::size_t index = 0; index < messages.size(); ++index) {
    if (index > 0) {
      std::cout << ',';
    }
    std::cout << messages[index];
  }
  std::cout << "]}\n" << std::flush;
}

std::size_t StreamMessages(
    const std::string& file_path,
    FIT_UINT16 target_message_number,
    const std::string& batch_type) {
  std::ifstream file(file_path, std::ios::in | std::ios::binary);
  if (!file.is_open()) {
    throw std::runtime_error("Unable to reopen FIT file");
  }
  fit::Decode decoder;
  fit::MesgBroadcaster broadcaster;
  BatchListener listener(target_message_number, batch_type);
  broadcaster.AddListener(static_cast<fit::MesgListener&>(listener));
  if (!decoder.Read(file, broadcaster, broadcaster)) {
    throw std::runtime_error("FIT decoder stopped before reaching the end of the file");
  }
  listener.FlushBatch();
  return listener.MessageCount();
}

int Run(const std::string& file_path) {
  fit::Decode metadata_decoder;
  MetadataListener metadata;
  DecodeWithListener(file_path, metadata_decoder, metadata);
  WriteMetadata(metadata);
  WaitForContinue();

  const bool is_weight_file =
      metadata.FileType() == FIT_FILE_WEIGHT || metadata.HasWeightMessages();
  const std::size_t message_count = is_weight_file
      ? StreamMessages(file_path, FIT_MESG_NUM_WEIGHT_SCALE, "weights")
      : StreamMessages(file_path, FIT_MESG_NUM_RECORD, "records");
  std::cout << "{\"type\":\"end\",\"messageCount\":" << message_count << "}\n"
            << std::flush;
  return 0;
}

}  // namespace

int main(int argument_count, char* argument_values[]) {
  if (argument_count != 2) {
    std::cerr << "Usage: dofek-fit-decoder <file.fit>\n";
    return 2;
  }
  try {
    return Run(argument_values[1]);
  } catch (const std::exception& error) {
    std::cerr << "FIT decode failed: " << error.what() << '\n';
    return 1;
  } catch (...) {
    std::cerr << "FIT decode failed with an unknown native exception\n";
    return 1;
  }
}
