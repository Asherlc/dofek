#include <fstream>
#include <string>

#include "fit_device_info_mesg.hpp"
#include "fit_encode.hpp"
#include "fit_file_id_mesg.hpp"
#include "fit_record_mesg.hpp"

int main(int argc, char* argv[]) {
  if (argc != 3) return 2;
  std::fstream file(argv[1], std::ios::in | std::ios::out | std::ios::binary | std::ios::trunc);
  if (!file.is_open()) return 1;
  fit::Encode encoder(fit::ProtocolVersion::V20);
  encoder.Open(file);
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
