#include <fstream>
#include <filesystem>
#include <cstring>
#include <iterator>
#include <string>
#include <vector>

#include "fit_device_info_mesg.hpp"
#include "fit_encode.hpp"
#include "fit_crc.hpp"
#include "fit_file_id_mesg.hpp"
#include "fit_record_mesg.hpp"
#include "fit_weight_scale_mesg.hpp"

int main(int argc, char* argv[]) {
  if (argc != 3) return 2;
  std::fstream file(argv[1], std::ios::in | std::ios::out | std::ios::binary | std::ios::trunc);
  if (!file.is_open()) return 1;
  fit::Encode encoder(fit::ProtocolVersion::V20);
  encoder.Open(file);
  const std::string fixture_mode(argv[2]);
  if (fixture_mode.rfind("recovery-", 0) == 0) {
    fit::FileIdMesg file_id;
    const bool chained_header = fixture_mode.rfind("recovery-chained-", 0) == 0 ||
                                fixture_mode == "recovery-intact-chain";
    const bool non_activity = fixture_mode == "recovery-nonactivity";
    const bool missing_type = fixture_mode == "recovery-missing-type";
    if (!missing_type) {
      file_id.SetType(fixture_mode == "recovery-weight" ? FIT_FILE_WEIGHT
                      : non_activity ? FIT_FILE_SETTINGS
                      : FIT_FILE_ACTIVITY);
    }
    file_id.SetManufacturer(FIT_MANUFACTURER_GARMIN);
    encoder.Write(file_id);
    if (fixture_mode == "recovery-weight") {
      fit::WeightScaleMesg weight;
      weight.SetTimestamp(1000000000);
      weight.SetWeight(75000);
      encoder.Write(weight);
    } else if (fixture_mode != "recovery-empty") {
      fit::RecordMesg record;
      record.SetHeartRate(140);
      if (fixture_mode != "recovery-invalid-timestamp") {
        record.SetTimestamp(1000000000);
      }
      encoder.Write(record);
      if (fixture_mode == "recovery-malformed" || fixture_mode == "recovery-footer-overlap") {
        const std::streampos final_record = file.tellp();
        record.SetTimestamp(1000000001);
        encoder.Write(record);
        if (!encoder.Close()) return 1;
        file.close();
        if (fixture_mode == "recovery-footer-overlap") {
          std::fstream overlap(argv[1], std::ios::in | std::ios::out | std::ios::binary);
          FIT_FILE_HDR header{};
          overlap.read(reinterpret_cast<char*>(&header), sizeof(header));
          header.data_size -= 2;
          header.crc = fit::CRC::Calc16(&header, FIT_STRUCT_OFFSET(crc, FIT_FILE_HDR));
          overlap.seekp(0);
          overlap.write(reinterpret_cast<const char*>(&header), sizeof(header));
          overlap.close();
          std::filesystem::resize_file(argv[1], std::filesystem::file_size(argv[1]) - 2);
          return 0;
        }
        std::fstream corrupt(argv[1], std::ios::in | std::ios::out | std::ios::binary);
        corrupt.seekp(final_record);
        const char undefined_local = 0x0F;
        corrupt.write(&undefined_local, 1);
        return 0;
      }
    }
    if (fixture_mode == "recovery-activity-weight") {
      fit::WeightScaleMesg weight;
      weight.SetTimestamp(1000000001);
      weight.SetWeight(75000);
      encoder.Write(weight);
    }
    const std::streampos data_end = file.tellp();
    if (!encoder.Close()) return 1;
    file.close();
    if (chained_header) {
      std::ifstream input(argv[1], std::ios::binary);
      std::vector<char> segment(std::istreambuf_iterator<char>(input), {});
      FIT_FILE_HDR header{};
      std::memcpy(&header, segment.data(), sizeof(header));
      if (fixture_mode == "recovery-chained-signature") {
        header.data_type[0] = 'X';
      } else if (fixture_mode == "recovery-chained-size") {
        header.header_size = 4;
      }
      header.crc = fit::CRC::Calc16(&header, FIT_STRUCT_OFFSET(crc, FIT_FILE_HDR));
      std::memcpy(segment.data(), &header, sizeof(header));
      std::ofstream output(argv[1], std::ios::binary | std::ios::app);
      output.write(segment.data(), static_cast<std::streamsize>(segment.size()));
      return output.good() ? 0 : 1;
    } else if (fixture_mode == "recovery-invalid-header" ||
               fixture_mode == "recovery-header-signature" ||
               fixture_mode == "recovery-header-protocol" ||
               fixture_mode == "recovery-header-zero-data") {
      std::fstream corrupt(argv[1], std::ios::in | std::ios::out | std::ios::binary);
      FIT_FILE_HDR header{};
      corrupt.read(reinterpret_cast<char*>(&header), sizeof(header));
      if (fixture_mode == "recovery-invalid-header") {
        header.header_size = 4;
      } else if (fixture_mode == "recovery-header-signature") {
        header.data_type[0] = 'X';
      } else if (fixture_mode == "recovery-header-protocol") {
        header.protocol_version = 0xF0;
      } else {
        header.data_size = 0;
      }
      header.crc = fit::CRC::Calc16(&header, FIT_STRUCT_OFFSET(crc, FIT_FILE_HDR));
      corrupt.seekp(0);
      corrupt.write(reinterpret_cast<const char*>(&header), sizeof(header));
    } else if (fixture_mode == "recovery-truncated") {
      std::filesystem::resize_file(argv[1], static_cast<std::uintmax_t>(data_end));
    } else if (fixture_mode == "recovery-crc" || fixture_mode == "recovery-weight" ||
               fixture_mode == "recovery-empty" || fixture_mode == "recovery-nonactivity" ||
               fixture_mode == "recovery-missing-type" ||
               fixture_mode == "recovery-invalid-timestamp" ||
               fixture_mode == "recovery-activity-weight") {
      std::fstream corrupt(argv[1], std::ios::in | std::ios::out | std::ios::binary);
      corrupt.seekg(-1, std::ios::end);
      char byte = 0;
      corrupt.read(&byte, 1);
      byte ^= 0xFF;
      corrupt.seekp(-1, std::ios::end);
      corrupt.write(&byte, 1);
    }
    return 0;
  }
  if (std::string(argv[2]) != "no-file-id") {
    fit::FileIdMesg file_id;
    file_id.SetType(FIT_FILE_ACTIVITY);
    file_id.SetManufacturer(FIT_MANUFACTURER_GARMIN);
    file_id.SetProduct(3121);
    file_id.SetSerialNumber(123456);
    encoder.Write(file_id);
  }
  for (int index = 0; index < 501; ++index) {
    fit::DeviceInfoMesg device;
    device.SetDeviceIndex(1);
    if (index == 0) {
      device.SetManufacturer(FIT_MANUFACTURER_GARMIN);
      device.SetSerialNumber(987654);
      device.SetProductName(L"Observed sensor");
    } else {
      device.SetBatteryVoltage(3.0F - (index % 4) * 0.25F);
    }
    if (std::string(argv[2]) == "byte-bound") {
      for (FIT_UINT8 value_index = 0; value_index < 250; ++value_index) {
        device.SetFieldUINT8Value(0, 200, value_index);
        device.SetFieldUINT8Value(1, 200, value_index);
        device.SetFieldUINT8Value(25, 200, value_index);
      }
    }
    encoder.Write(device);
    if (index == 250) {
      fit::RecordMesg record;
      record.SetTimestamp(1000000000);
      record.SetHeartRate(140);
      encoder.Write(record);
    }
  }
  return encoder.Close() ? 0 : 1;
}
