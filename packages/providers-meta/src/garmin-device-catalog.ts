// Garmin Connect IQ device catalog snapshot, 2026-10-24.
// https://apps.garmin.com/api/appsLibraryExternalServices/api/asw/deviceTypes
// Verified Garmin Connect transparent product assets are preferred where available.
const GARMIN_DEVICE_CATALOG: ReadonlyArray<readonly [names: readonly string[], imageUrl: string]> =
  [
    [["Forerunner® 235"], "https://static.garmincdn.com/en/products/010-03717-54/v/cf-sm.jpg"],
    [["vívoactive®"], "https://static.garmincdn.com/en/products/010-01297-00/v/cf-sm.jpg"],
    [
      ["vívoactive® 3", "vívolife"],
      "https://static.garmincdn.com/en/products/010-01769-00/v/cf-sm.jpg",
    ],
    [["vívoactive® HR"], "https://static.garmincdn.com/en/products/010-01605-03/g/cf-sm.jpg"],
    [
      [
        "Instinct® 2",
        "Instinct® 2 - Camo Edition",
        "Instinct® 2 Solar - Tactical Edition",
        "Instinct® 2 Solar - Surf Edition",
        "Instinct® 2 - dēzl™ Edition",
        "Instinct® 2 Dual Power",
        "Instinct® 2 Dual Power - Tactical Edition",
        "Instinct® 2 Dual Power ONE PIECE LUFFY ",
      ],
      "https://static.garmincdn.com/en/products/010-02627-16/v/sc-05-sm-8e5d5a4c-63fa-4680-8dc0-e0f329a5debd.jpg",
    ],
    [["Instinct® 2X"], "https://res.garmin.com/en/products/010-02805-10/v/c1_01_md.png"],
    [
      ["Instinct® Crossover", "Instinct® Crossover Dual Power"],
      "https://res.garmin.com/en/products/010-02730-11/v/c1_01_md.png",
    ],
    [["Instinct® E – 40 mm"], "https://res.garmin.com/en/products/010-02932-00/v/c1_01_md.png"],
    [["Instinct® E – 45 mm"], "https://res.garmin.com/en/products/010-02933-00/v/c1_01_md.png"],
    [
      ["Instinct® 3 – 45 mm, AMOLED"],
      "https://res.garmin.com/en/products/010-02936-00/v/c1_01_md.png",
    ],
    [
      ["Instinct® 3 – 45 mm, Solar"],
      "https://res.garmin.com/en/products/010-02934-00/v/c1_01_md.png",
    ],
    [
      ["Instinct® 3 – 50 mm, Solar", "Instinct® 3 – 50 mm"],
      "https://res.garmin.com/en/products/010-02935-00/v/c1_01_md.png",
    ],
    [
      ["Instinct® Crossover AMOLED"],
      "https://res.garmin.com/en/products/010-03398-00/v/c1_01_md.png",
    ],
    [
      ["Instinct® 3 – 50 mm, AMOLED", "Instinct® 3 – 50 mm"],
      "https://res.garmin.com/en/products/010-03020-00/v/c1_01_md.png",
    ],
    [["fēnix® 5S"], "https://static.garmincdn.com/en/products/010-01685-00/v/cf-md.jpg"],
    [
      ["fēnix® 5", "quatix® 5"],
      "https://static.garmincdn.com/en/products/010-01688-00/v/cf-sm.jpg",
    ],
    [
      ["fēnix® 5X", "tactix® Charlie"],
      "https://static.garmincdn.com/en/products/010-01733-00/v/cf-md.jpg",
    ],
    [
      [
        "Instinct® 2S",
        "Instinct® 2S - Camo Edition",
        "Instinct® 2S Solar - Tactical Edition",
        "Instinct® 2S Solar - Surf Edition",
        "Instinct® 2S - dēzl™ Edition",
        "Instinct® 2S Dual Power",
        "Instinct® 2S Dual Power - Surf Edition",
        "Instinct® 2S Dual Power ONE PIECE CHOPPER",
      ],
      "https://static.garmincdn.com/en/products/010-02564-11/v/sc-02-sm-426e622a-2b1c-4296-9c52-e7a45755eee1.jpg",
    ],
    [
      ["vívoactive® 3 Music"],
      "https://static.garmincdn.com/en/products/010-01985-03/v/cf-sm-cc4e0386-75e2-4c2f-8cc5-59cca47faed6.jpg",
    ],
    [["Descent™ Mk1"], "https://static.garmincdn.com/en/products/010-01760-00/v/cf-sm.jpg"],
    [
      ["Descent™ MK2", "Descent™MK2i"],
      "https://static.garmincdn.com/en/products/010-02132-00/v/pd-03-sm-5dcaa3d1-3191-4acb-b602-7790096bddd6.jpg",
    ],
    [
      ["Descent™ Mk2S"],
      "https://static.garmincdn.com/en/products/010-02403-00/v/cm-sm-ffd44110-3573-4463-9894-dd6896cdef35.png",
    ],
    [
      ["Descent™ MK3i - 51mm", "Descent™ MK3i -51mm"],
      "https://res.garmin.com/en/products/010-02752-10/v/c1_01_md.png",
    ],
    [
      ["Descent™ MK3 - 43mm", "Descent™ MK3i - 43mm", "Descent™ MK3 (43mm)"],
      "https://res.garmin.com/en/products/010-02753-03/v/c1_01_md.png",
    ],
    [["Descent™ G2"], "https://res.garmin.com/en/products/010-02986-01/v/c1_01_md.png"],
    [
      ["Venu® 2"],
      "https://static.garmincdn.com/en/products/010-02430-10/v/cm-sm-26d3d922-fbce-45e1-9851-0fc7cd29f2c0.png",
    ],
    [
      ["Venu® 2S"],
      "https://static.garmincdn.com/en/products/010-02429-10/v/cm-sm-9e11f013-57fa-4143-aeba-20804d29ec5c.png",
    ],
    [
      ["Venu® 2 Plus"],
      "https://static.garmincdn.com/en/products/010-02496-10/v/pd-01-sm-8096ba5b-467d-406a-8207-6e2b8a609d2f.jpg",
    ],
    [
      ["ForeAthlete® 235J", "Forerunner® 235"],
      "https://static.garmincdn.com/en/products/010-03717-54/g/cf-sm.jpg",
    ],
    [["fēnix® 3 HR"], "https://static.garmincdn.com/en/products/010-01338-70/g/cf-sm.jpg"],
    [
      ["fēnix® 3", "quatix® 3", "tactix® Bravo"],
      "https://static.garmincdn.com/en/products/010-01338-00/v/cf-sm.jpg",
    ],
    [["Venu® 3"], "https://res.garmin.com/en/products/010-02784-00/v/c1_01_md.png"],
    [["Venu® 3S"], "https://res.garmin.com/en/products/010-02785-00/v/c1_01_md.png"],
    [["Venu® 4 – 41 mm"], "https://res.garmin.com/en/products/010-03013-00/v/c1_01_md.png"],
    [["Venu® 4 – 45 mm"], "https://res.garmin.com/en/products/010-03014-00/v/c1_01_md.png"],
    [["Venu® X1"], "https://res.garmin.com/en/products/010-02980-00/v/c1_01_md.png"],
    [
      ["ForeAthlete 935", "Forerunner® 935"],
      "https://static.garmincdn.com/en/products/010-01746-00/v/cf-sm.jpg",
    ],
    [["Forerunner® 920XT"], "https://static.garmincdn.com/en/products/010-01174-00/v/cf-sm.jpg"],
    [["Forerunner® 230"], "https://static.garmincdn.com/en/products/010-03717-40/v/cf-sm.jpg"],
    [["Forerunner® 630"], "https://static.garmincdn.com/en/products/010-03717-00/v/cf-sm.jpg"],
    [
      ["Forerunner® 645", "ForeAthlete 645"],
      "https://static.garmincdn.com/en/products/010-01863-10/v/cf-sm-3d860c6d-aec3-4fcd-8544-3ec55190a637.jpg",
    ],
    [
      ["Mercedes-Benz Venu® 2"],
      "https://static.garmincdn.com/en/products/010-02430-22/v/cf-sm-c77f7728-90d5-4be1-a73b-b988ed45bcc1.png",
    ],
    [
      ["Mercedes-Benz Venu® 2S"],
      "https://static.garmincdn.com/en/products/010-02429-20/v/cf-sm-06f6a68d-b824-401d-b65e-dd33db5cb6cf.png",
    ],
    [
      ["Forerunner® 645 Music", "ForeAthlete 645 Music"],
      "https://static.garmincdn.com/en/products/010-01863-30/v/cf-sm-cf7f4202-dce2-4c43-ab20-0d0ae12b35f3.jpg",
    ],
    [
      ["Edge® 1030, Bontrager", "Edge® 1030"],
      "https://static.garmincdn.com/en/products/010-01758-10/g/cf-sm.jpg",
    ],
    [["Edge® 1000"], "https://static.garmincdn.com/de/products/010-01161-01/g/cf-sm.jpg"],
    [
      ["Edge® 1030 Plus"],
      "https://static.garmincdn.com/en/products/010-02424-00/g/cf-sm-87bc593f-a77e-4708-8d5c-b45ce3c8f4a7.jpg",
    ],
    [
      ["Edge® 130 Plus"],
      "https://static.garmincdn.com/en/products/010-02385-00/g/cf-sm-f7af9045-fccf-41f7-a2d9-3f3bfec4a5ee.jpg",
    ],
    [
      ["Edge® 1040", "Edge® 1040 Dual Power"],
      "https://res.garmin.com/en/products/010-02503-00/v/c1_01_md.png",
    ],
    [["Edge® 1050"], "https://res.garmin.com/en/products/010-02890-00/v/c1_01_md.png"],
    [["Edge® Explore 2"], "https://res.garmin.com/en/products/010-02703-00/v/c1_01_md.png"],
    [["Edge® 520"], "https://static.garmincdn.com/en/products/010-01368-00/v/cf-sm.jpg"],
    [["epix™"], "https://static.garmincdn.com/en/products/010-01247-00/g/cf-sm.jpg"],
    [["Forerunner® 735XT"], "https://static.garmincdn.com/en/products/010-01614-00/v/cf-sm.jpg"],
    [
      ["D2™ Air"],
      "https://static.garmincdn.com/en/products/010-02173-41/g/cf-sm-11d59984-bc91-49ed-bfe9-d2ddc7c627a8.jpg",
    ],
    [
      ["D2™ Air X10"],
      "https://static.garmincdn.com/en/products/010-02496-09/v/pd-01-sm-bc0a4be7-cac1-424e-9343-dbadb33efabf.jpg",
    ],
    [["D2™ Air X15"], "https://res.garmin.com/en/products/010-03014-50/v/c1_01_md.png"],
    [["D2™ Bravo"], "https://static.garmincdn.com/en/products/010-01338-31/v/cf-sm.jpg"],
    [
      ["D2™ Mach 1"],
      "https://static.garmincdn.com/en/products/010-02582-50/g/cf-sm-072c4843-2066-4cd6-8d23-35dfcc65dd05.jpg",
    ],
    [["D2™ Mach 1 Pro"], "https://res.garmin.com/en/products/010-02804-80/v/c1_01_md.png"],
    [["D2™ Mach 2"], "https://res.garmin.com/en/products/010-02904-30/v/c1_01_md.png"],
    [["D2™ Mach 2 Pro"], "https://res.garmin.com/en/products/010-03199-50/v/c1_01_md.png"],
    [
      ["ForeAthlete® 920XTJ", "Forerunner® 920XT"],
      "https://static.garmincdn.com/en/products/010-01174-00/g/cf-sm.jpg",
    ],
    [["Edge® Explore 1000"], "https://static.garmincdn.com/en/products/010-01527-00/g/cf-sm.jpg"],
    [["D2™ Bravo Titanium"], "https://static.garmincdn.com/en/products/010-01338-36/v/cf-sm.jpg"],
    [
      ["D2™ Delta"],
      "https://static.garmincdn.com/en/products/010-01988-30/g/cf-sm-87bb0674-cc55-4a52-ad94-32bf9b4e729c.jpg",
    ],
    [
      ["D2™ Delta S"],
      "https://static.garmincdn.com/en/products/010-01987-30/g/cf-sm-431a8fa0-3449-43e0-9702-5ff6ad991c84.jpg",
    ],
    [
      ["D2™ Delta PX"],
      "https://static.garmincdn.com/en/products/010-01989-30/g/cf-sm-874810a3-a28b-4484-955d-6c4a24c4f7bf.jpg",
    ],
    [["D2™ Charlie"], "https://static.garmincdn.com/en/products/010-01733-30/v/cf-sm.jpg"],
    [
      ["tactix® 7", "tactix® 7 – Pro Ballistics Edition", "tactix® 7 – Pro Edition"],
      "https://static.garmincdn.com/en/products/010-02704-00/v/pd-01-sm-b5f086c9-db63-458e-b1c3-70076dff030d.jpg",
    ],
    [
      ["tactix® 7 – AMOLED Edition"],
      "https://res.garmin.com/en/products/010-02931-00/v/c1_01_md.png",
    ],
    [
      ["tactix® 8 – 47 mm, AMOLED", "tactix® 8 – 51 mm"],
      "https://res.garmin.com/en/products/010-03405-00/v/c1_01_md.png",
    ],
    [
      ["tactix® 8 – 51 mm, Solar", "tactix® 8 – 51 mm"],
      "https://res.garmin.com/en/products/010-03407-00/v/c1_01_md.png",
    ],
    [
      ["epix™ (Gen 2)", "quatix® 7 – Sapphire Edition"],
      "https://static.garmincdn.com/en/products/010-02582-00/v/sc-02-sm-a9a189e7-e6a6-4a21-a8f2-71d306469085.jpg",
    ],
    [["epix™ Pro (42mm)"], "https://res.garmin.com/en/products/010-02802-13/v/c1_01_md.png"],
    [
      ["epix™ Pro (47mm)", "quatix® 7 Pro"],
      "https://res.garmin.com/en/products/010-02803-00/v/c1_01_md.png",
    ],
    [["epix™ Pro (51mm)"], "https://res.garmin.com/en/products/010-02804-21/v/c1_01_md.png"],
    [["ForeAthlete® 230J"], "https://static.garmincdn.com/en/products/010-03717-40/g/cf-sm.jpg"],
    [
      ["ForeAthlete® 630J", "Forerunner® 630"],
      "https://static.garmincdn.com/en/products/010-03717-00/g/cf-sm.jpg",
    ],
    [["Oregon® 7 Series"], "https://static.garmincdn.com/en/products/010-01672-20/g/cf-sm.jpg"],
    [["fēnix® Chronos"], "https://static.garmincdn.com/en/products/010-01957-00/v/cf-sm.jpg"],
    [
      ["ForeAthlete® 735XTJ", "Forerunner® 735XT"],
      "https://static.garmincdn.com/en/products/010-01614-00/g/cf-sm.jpg",
    ],
    [["Edge® 820"], "https://static.garmincdn.com/en/products/010-01626-00/g/cf-sm.jpg"],
    [["Edge® Explore 820"], "https://static.garmincdn.com/en/products/010-01626-02/g/cf-sm.jpg"],
    [["Rino® 7 Series"], "https://static.garmincdn.com/en/products/010-01958-01/g/cf-sm.jpg"],
    [["fēnix® 3"], "https://static.garmincdn.com/en/products/010-01338-21/g/cf-sm.jpg"],
    [
      ["Montana® 700", "Montana 700", "Montana 700i", "Montana 750i"],
      "https://static.garmincdn.com/en/products/010-02133-00/g/cf-sm-eed10c23-6410-4fb4-bbe7-d235d8c1de78.jpg",
    ],
    [["fēnix® 3"], "https://static.garmincdn.com/en/products/010-01338-00/g/cf-sm.jpg"],
    [
      [
        "Descent™ G1",
        "Descent™ G1 Solar",
        "Descent™ G1 Solar - Ocean Edition",
        "Descent™ G1 Dual Power",
        "Descent™ G1 Dual Power - Ocean Edition",
      ],
      "https://static.garmincdn.com/en/products/010-02604-00/g/cf-sm-d5a36bc4-dc37-4747-a026-4dc1d6a289b7.jpg",
    ],
    [["vívoactive®"], "https://static.garmincdn.com/en_GB/products/010-01297-00/de/cf-sm.jpg"],
    [["D2™ Bravo"], "https://static.garmincdn.com/en/products/010-01338-36/g/cf-sm.jpg"],
    [["Edge® 1000"], "https://static.garmincdn.com/de_DE/products/010-01161-04/g/cf-sm.jpg"],
    [["Edge® 1030"], "https://static.garmincdn.com/en/products/010-01758-10/v/cf-sm.jpg"],
    [["Edge® 520"], "https://static.garmincdn.com/en/products/010-01368-00/g/cf-sm.jpg"],
    [["Montana® 710"], "https://res.garmin.com/en/products/010-02964-10/v/c1_01_md.png"],
    [["Approach® S60"], "https://static.garmincdn.com/en/products/010-01702-00/v/cf-sm.jpg"],
    [
      ["GPSMAP® 67", "GPSMAP® 67i"],
      "https://res.garmin.com/en/products/010-02813-00/v/c1_01_md.png",
    ],
    [
      ["GPSMAP® H1", "GPSMAP® H1i Plus"],
      "https://res.garmin.com/en/products/010-02920-00/v/c1_01_md.png",
    ],
    [["eTrex® Touch"], "https://res.garmin.com/en/products/010-02940-00/v/pd-03-sm.jpg"],
    [
      ["Approach® S62"],
      "https://static.garmincdn.com/en/products/010-02200-00/v/pd-03-sm-32c3215c-7217-4a09-9b06-adeda2ed555a.jpg",
    ],
    [["Approach® S70 (47mm)"], "https://res.garmin.com/en/products/010-02746-22/v/c1_01_md.png"],
    [["Approach® S70 (42mm)"], "https://res.garmin.com/en/products/010-02746-10/v/c1_01_md.png"],
    [["Approach® S50"], "https://res.garmin.com/en/products/010-03010-00/v/pd-03-sm.jpg"],
    [
      ["MARQ™ Driver"],
      "https://static.garmincdn.com/en/products/010-02006-00/g/cf-sm-2f580581-696f-4e11-808b-c8acd963de46.jpg",
    ],
    [
      [
        "MARQ® (Gen 2)",
        "MARQ® Carbon Collection",
        "MARQ® Adventurer (Gen 2) - Damascus Steel Edition",
      ],
      "https://res.garmin.com/en/products/010-02648-30/v/c1_01_md.png",
    ],
    [["MARQ™ Aviator (Gen 2)"], "https://res.garmin.com/en/products/010-02648-00/v/c1_01_md.png"],
    [
      ["MARQ® Commander (Gen 2) – Carbon Edition"],
      "https://res.garmin.com/en/products/010-02722-00/v/c1_01_md.png",
    ],
    [
      ["MARQ™ Aviator"],
      "https://static.garmincdn.com/en/products/010-02006-03/g/cf-sm-614d7b98-9b70-4c8a-bec7-5ee303166767.jpg",
    ],
    [
      ["fēnix® 5 Plus"],
      "https://static.garmincdn.com/en/products/010-01988-10/v/cf-sm-c9091bfe-f1af-42b4-bd62-f3b45f46a15d.jpg",
    ],
    [
      ["MARQ™ Captain", "MARQ™ Captain: American Magic Edition"],
      "https://static.garmincdn.com/en/products/010-02006-06/g/cf-sm-04034f67-9380-4d27-b5aa-678600fb8b5f.jpg",
    ],
    [
      ["fēnix® 5S Plus"],
      "https://static.garmincdn.com/en/products/010-01987-00/v/cf-sm-58f98bed-90e7-4199-b4bc-925aec9690a7.jpg",
    ],
    [
      ["MARQ™ Commander"],
      "https://static.garmincdn.com/en/products/010-02006-11/g/rf-sm-517ae5f4-8789-49b5-ad89-d2002ee9f8e3.jpg",
    ],
    [
      ["fēnix® 5X Plus"],
      "https://static.garmincdn.com/en/products/010-01989-04/v/cf-sm-6dd29412-ddad-4f53-b62d-84eaaa06f258.jpg",
    ],
    [
      ["MARQ™ Expedition"],
      "https://static.garmincdn.com/en/products/010-02006-12/g/cf-sm-4d82de5c-a266-4cb0-abd1-a167526e2669.jpg",
    ],
    [
      ["Edge® 520 Plus"],
      "https://static.garmincdn.com/en/products/010-02083-00/v/cf-sm-222cacb8-6733-4d20-8ad9-6c69b4fc917b.jpg",
    ],
    [
      ["MARQ™ Athlete"],
      "https://static.garmincdn.com/en/products/010-02006-15/g/cf-sm-0b73c33d-2df0-4d7e-b438-fd23d7c4390f.jpg",
    ],
    [
      ["Edge® Explore"],
      "https://static.garmincdn.com/en/products/010-02029-00/g/cf-sm-989c05c5-db39-4699-9692-440101e52cce.jpg",
    ],
    [
      ["Forerunner® 245", "ForeAthlete 245"],
      "https://static.garmincdn.com/en/products/010-02120-00/v/cf-sm-13aa6bd1-4382-4520-ba05-be6a77decdbf.jpg",
    ],
    [
      ["Edge® 530", "Edge® 830"],
      "https://static.garmincdn.com/en/products/010-02060-00/v/cf-sm-4eb7ba21-1912-4616-bdf2-87c56008c2b8.jpg",
    ],
    [
      ["Edge® 130"],
      "https://static.garmincdn.com/en/products/010-01913-00/v/cf-sm-a859efd3-adee-4924-ad86-8883b05468fd.jpg",
    ],
    [
      ["Forerunner® 245 Music", "ForeAthlete 245 Music"],
      "https://static.garmincdn.com/en/products/010-02120-20/v/cf-sm-3f7eab23-b754-4e70-aba1-518f230a57f7.jpg",
    ],
    [
      ["GPSMAP® 66s / 66st"],
      "https://static.garmincdn.com/en/products/010-01918-00/g/cf-sm-239388ff-962c-49e5-bd4d-9d0936be669d.jpg",
    ],
    [
      ["vívoactive® 3 Mercedes-Benz® Collection", "vívoactive® 3"],
      "https://static.garmincdn.com/en/products/010-01769-01/g/cf-sm-01b9b246-bee9-46f0-a42d-db98ddfea352.jpg",
    ],
    [
      ["vívoactive® 4", "GarminActive"],
      "https://static.garmincdn.com/en/products/010-02174-12/v/cf-sm-ea8594d6-289b-4a61-b99c-0566e02a9b43.jpg",
    ],
    [
      ["vívoactive® 4S", "GarminActive S"],
      "https://static.garmincdn.com/en/products/010-02172-32/v/cf-sm-dd867152-525f-4622-a4f4-d7a09dcea813.jpg",
    ],
    [["vívoactive® 5"], "https://res.garmin.com/en/products/010-02862-10/v/c1_01_md.png"],
    [["vívoactive® 6"], "https://res.garmin.com/en/products/010-02985-00/v/c1_01_md.png"],
    [
      ["Venu®"],
      "https://static.garmincdn.com/en/products/010-02173-12/v/cf-sm-9af674f3-640f-43f0-91df-117ed510ffcf.jpg",
    ],
    [
      ["Venu® Sq. Music"],
      "https://static.garmincdn.com/en/products/010-02426-00/v/pd-03-sm-3fe44d78-b9a2-4f69-9530-152a9e1b8daa.jpg",
    ],
    [
      ["Venu® Sq."],
      "https://static.garmincdn.com/en/products/010-02427-00/v/pd-03-sm-9fec0ed3-32bb-4284-aae2-5c0fe4a66c8a.jpg",
    ],
    [["Venu® Sq. 2 Music"], "https://res.garmin.com/en/products/010-02700-00/v/c1_01_md.png"],
    [["Venu® Sq. 2"], "https://res.garmin.com/en/products/010-02701-00/v/c1_01_md.png"],
    [
      ["Captain Marvel"],
      "https://static.garmincdn.com/en/products/010-02172-41/g/cf-sm-0a318bb6-9baa-4c5d-b344-19de0c656cd7.jpg",
    ],
    [["Forerunner® 255"], "https://res.garmin.com/en/products/010-02641-01/v/c1_01_md.png"],
    [["Forerunner® 255S"], "https://res.garmin.com/en/products/010-02641-02/v/c1_01_md.png"],
    [["Forerunner® 255 Music"], "https://res.garmin.com/en/products/010-02641-20/v/c1_01_md.png"],
    [["Forerunner® 255S Music"], "https://res.garmin.com/en/products/010-02641-23/v/c1_01_md.png"],
    [["Forerunner® 265S"], "https://res.garmin.com/en/products/010-02810-03/v/c1_01_md.png"],
    [["Forerunner® 265"], "https://res.garmin.com/en/products/010-02810-00/v/c1_01_md.png"],
    [["Forerunner® 965"], "https://res.garmin.com/en/products/010-02809-00/v/c1_01_md.png"],
    [
      ["First Avenger"],
      "https://static.garmincdn.com/en/products/010-02174-41/g/cf-sm-f2db5e1c-5419-42b2-9f22-c4da61e9878a.jpg",
    ],
    [
      ["Rey™"],
      "https://static.garmincdn.com/en/products/010-02172-51/g/rf-sm-f55ac7b5-223c-4c58-ba98-8b6938b26bc0.jpg",
    ],
    [
      ["Darth Vader™"],
      "https://static.garmincdn.com/en/products/010-02174-51/g/rf-sm-068425e4-b235-460f-a031-304d364ebb6c.jpg",
    ],
    [
      ["Forerunner® 45", "ForeAthlete 45", "ForeAthlete 45S"],
      "https://static.garmincdn.com/en/products/010-02156-05/v/cf-sm-ddce0f3c-16b2-4cfc-bd14-7e541f5412bc.jpg",
    ],
    [
      ["Forerunner® 45 Plus"],
      "https://static.garmincdn.com/en/products/010-02156-17/g/pd-01-sm-10961d0d-93c9-408a-a577-4feb56faa580.jpg",
    ],
    [
      ["Forerunner® 55", "ForeAthlete 55", "Forerunner® 158 "],
      "https://static.garmincdn.com/en/products/010-02562-00/v/pd-02-sm-6b38e8ac-6ca8-41d0-8ef4-a064dbba6a1f.jpg",
    ],
    [["Forerunner® 70"], "https://res.garmin.com/en/products/010-04307-03/v/c1_01_md.png"],
    [["Forerunner® 170 Music"], "https://res.garmin.com/en/products/010-03920-12/v/c1_01_md.png"],
    [["Forerunner® 170"], "https://res.garmin.com/en/products/010-03920-00/v/c1_01_md.png"],
    [["Forerunner® 165"], "https://res.garmin.com/en/products/010-02863-20/v/c1_01_md.png"],
    [["Forerunner® 165 Music"], "https://res.garmin.com/en/products/010-02863-31/v/c1_01_md.png"],
    [["Forerunner® 570 - 42mm"], "https://res.garmin.com/en/products/010-02970-01/v/c1_01_md.png"],
    [["Forerunner® 570 - 47mm"], "https://res.garmin.com/en/products/010-02971-00/v/c1_01_md.png"],
    [["Forerunner® 970"], "https://res.garmin.com/pl_PL/products/010-02969-00/v/rf-sm.jpg"],
    [
      ["fēnix® 6S"],
      "https://static.garmincdn.com/en/products/010-02159-00/v/cf-sm-880ca1fb-2302-4a53-bfda-962e357fd7f8.jpg",
    ],
    [
      ["fēnix® 6S Pro", "fēnix® 6S Sapphire"],
      "https://static.garmincdn.com/en/products/010-02159-14/v/cf-sm-6f0a6934-59f4-467c-8a6d-e74cb01d5ca6.jpg",
    ],
    [
      ["fēnix® 6"],
      "https://static.garmincdn.com/en/products/010-02158-11/v/cf-sm-d9660dd6-f71d-4fe6-8682-2f6d80e12dff.jpg",
    ],
    [
      ["fēnix® 6 Pro", "fēnix® 6 Sapphire"],
      "https://static.garmincdn.com/en/products/010-02158-02/v/cf-sm-c561cac8-1a27-4bb1-8374-d99dc6afe57a.jpg",
    ],
    [
      [
        "fēnix® 6X Pro",
        "fēnix® 6X Sapphire",
        "fēnix® 6X Pro Solar",
        "tactix® Delta Sapphire",
        "quatix® 6X Solar",
        "tactix® Delta Solar",
        "tactix® Delta Solar Ballistics",
        "tactix® Delta Solar:Ballisitcs Edition",
        "fēnix® 6X Pro Dual Power",
      ],
      "https://static.garmincdn.com/en/products/010-02157-01/v/cf-sm-47dff6dd-beb7-42eb-9daa-3585c81c12ea.jpg",
    ],
    [
      ["Enduro™"],
      "https://static.garmincdn.com/en/products/010-02408-00/v/pd-01-sm-d11e8da1-0277-4007-a62f-d41c0343b6cd.jpg",
    ],
    [["Enduro™ 2"], "https://res.garmin.com/en/products/010-02754-00/v/c1_01_md.png"],
    [["Enduro™ 3"], "https://res.garmin.com/en/products/010-02751-00/v/c1_01_md.png"],
    [
      ["fēnix® 8 Solar (47mm)", "fēnix® 8 Dual Power (47mm)"],
      "https://res.garmin.com/en/products/010-02906-10/v/c1_01_md.png",
    ],
    [
      ["fēnix® 8 Solar (51mm)", "fēnix® 8 Dual Power (51mm)"],
      "https://res.garmin.com/en/products/010-02907-10/v/c1_01_md.png",
    ],
    [
      [
        "fēnix® 8 Pro",
        "fēnix® 8 Pro – 47 mm AMOLED",
        "fēnix® 8 Pro – 51 mm AMOLED",
        "fēnix® 8 Pro – 51 mm MicroLED",
        "quatix® 8 Pro - 47mm AMOLED",
        "quatix® 8 Pro - 51mm AMOLED",
      ],
      "https://res.garmin.com/en/products/010-03380-00/v/c1_01_md.png",
    ],
    [["fēnix® E"], "https://res.garmin.com/en/products/010-03025-02/v/c1_01_md.png"],
    [
      ["Forerunner® 745", "ForeAthlete 745"],
      "https://static.garmincdn.com/en/products/010-02445-00/v/pd-01-sm-08be35f2-d0c8-4f90-8bba-79330826183f.jpg",
    ],
    [
      ["fēnix® 6 Solar", "fēnix® 6 Dual Power"],
      "https://static.garmincdn.com/en/products/010-02410-00/v/pd-04-sm-05fc6663-0a28-451a-aa9d-8595a8238209.jpg",
    ],
    [
      ["fēnix® 6 Pro Solar", "fēnix® 6 Pro Dual Power"],
      "https://static.garmincdn.com/en/products/010-02410-10/v/rf-sm-f9532945-ccc5-430c-9bd7-8a0f50b7fb1d.jpg",
    ],
    [
      ["fēnix® 6S Solar", "fēnix® 6S Dual Power"],
      "https://res.garmin.com/en/products/010-02409-00/v/c1_01_md.png",
    ],
    [
      ["fēnix® 6S Pro Solar", "fēnix® 6S Pro Dual Power"],
      "https://static.garmincdn.com/en/products/010-02409-15/v/rf-sm-4d0f762d-bb36-4d24-b4fe-c897e246ab91.jpg",
    ],
    [
      [
        "fēnix® 7S",
        "fēnix® 7S– Solar Edition",
        "fēnix® 7S– Sapphire Solar Edition",
        "fēnix® 7S– Sapphire Dual Power Edition",
      ],
      "https://static.garmincdn.com/en/products/010-02539-00/g/cf-sm-3ecb177b-cbcd-41dd-80e5-c954164a0955.jpg",
    ],
    [
      [
        "fēnix® 7",
        "quatix® 7",
        "fēnix® 7– Sapphire Dual Power Edition",
        "fēnix® 7– Sapphire Solar Edition",
        "fēnix® 7 Solar",
      ],
      "https://static.garmincdn.com/en/products/010-02540-00/v/rf-sm-79088307-fcf5-4dff-9eb9-3090f92db1bb.jpg",
    ],
    [
      [
        "fēnix® 7 Pro",
        "fēnix® 7 Pro – Solar Edition",
        "fēnix® 7 Pro – Sapphire Solar Edition",
        "fēnix® 7 Pro– Sapphire Dual Power Edition",
      ],
      "https://res.garmin.com/en/products/010-02777-01/v/c1_01_md.png",
    ],
    [
      [
        "fēnix® 7S Pro",
        "fēnix® 7S Pro– Sapphire Solar Edition",
        "fēnix® 7S Pro– Sapphire Dual Power Edition",
      ],
      "https://res.garmin.com/en/products/010-02776-30/v/c1_01_md.png",
    ],
    [
      [
        "fēnix® 7X Pro",
        "fēnix® 7X Pro– Sapphire Solar Edition",
        "fēnix® 7X Pro– Sapphire Dual Power Edition",
      ],
      "https://res.garmin.com/en/products/010-02778-00/v/c1_01_md.png",
    ],
    [
      ["fēnix® 7 Pro – Solar Edition (No Wi-Fi®)"],
      "https://res.garmin.com/en/products/010-02777-13/v/c1_01_md.png",
    ],
    [["fēnix® 7X Pro No Wi-Fi"], "https://res.garmin.com/en/products/010-02778-13/v/c1_01_md.png"],
    [["fēnix® 8 AMOLED (43mm)"], "https://res.garmin.com/en/products/010-02903-00/v/c1_01_md.png"],
    [
      ["fēnix® 8 AMOLED (47mm/51mm)", "quatix® 8 AMOLED (47mm/51mm)"],
      "https://res.garmin.com/en/products/010-02905-00/v/c1_01_md.png",
    ],
    [
      [
        "fēnix® 7X",
        "fēnix® 7X - Solar Edition",
        "fēnix® 7X– Sapphire Solar Edition",
        "quatix® 7X – Solar Edition",
        "fēnix® 7X– Sapphire Dual Power Edition",
        "quatix® 7X",
      ],
      "https://static.garmincdn.com/en/products/010-02541-11/v/sc-03-sm-cd878574-7789-4323-a2f2-1acebcff5f36.jpg",
    ],
    [
      ["Forerunner® 945"],
      "https://static.garmincdn.com/en/products/010-02063-00/v/cf-sm-538e211f-f991-4d7a-91f7-d25d4feb9a99.jpg",
    ],
    [
      ["Edge® 540", "Edge® 540 Dual Power"],
      "https://res.garmin.com/en/products/010-02694-00/v/c1_01_md.png",
    ],
    [
      ["Edge® 840", "Edge® 840 Dual Power"],
      "https://res.garmin.com/en/products/010-02695-00/v/c1_01_md.png",
    ],
    [["Edge® MTB"], "https://res.garmin.com/en/products/010-02993-10/v/c1_01_md.png"],
    [["Edge® 550"], "https://res.garmin.com/en/products/010-03022-00/v/c1_01_md.png"],
    [["Edge® 850"], "https://res.garmin.com/en/products/010-03023-00/v/c1_01_md.png"],
    [
      ["Forerunner® 945 LTE"],
      "https://static.garmincdn.com/en/products/010-02383-00/v/rf-sm-333473bc-693b-47c4-aaa8-dbb0768ddaa3.jpg",
    ],
    [
      ["Forerunner® 955 Dual Power"],
      "https://res.garmin.com/en/products/010-02638-10/v/c1_01_md.png",
    ],
    [
      ["GPSMAP® 66sr"],
      "https://static.garmincdn.com/en/products/010-02431-00/g/pd-02-sm-43db5af0-0ae8-43ff-819d-da2f8c5f5e1f.jpg",
    ],
    [
      ["GPSMAP® 66i"],
      "https://static.garmincdn.com/en/products/010-02088-01/g/cf-sm-7eea9327-3b51-4860-ab75-e2c1c33bd952.jpg",
    ],
    [
      ["GPSMAP® 86i"],
      "https://static.garmincdn.com/en/products/010-02236-00/g/cf-sm-7765c2a0-e04a-4aa0-9e77-51590be1a005.jpg",
    ],
    [
      ["GPSMAP® 86s"],
      "https://static.garmincdn.com/en/products/010-02235-00/g/cf-sm-b5128964-2292-4542-86e2-6becc7a575ca.jpg",
    ],
    [
      ["GPSMAP® 86sc"],
      "https://static.garmincdn.com/en/products/010-02235-02/g/cf-sm-3ff30e86-a84c-495c-bf05-3e0ddc30aa51.jpg",
    ],
    [
      ["GPSMAP® 86sci"],
      "https://static.garmincdn.com/en/products/010-02236-02/g/cf-sm-3837365d-0d5a-4a92-b330-de1f1ec75234.jpg",
    ],
    [
      ["MARQ™ Adventurer"],
      "https://static.garmincdn.com/en/products/010-02006-26/g/cf-sm-f78826d3-cb9a-42f0-871c-ca80cc34c5a4.jpg",
    ],
    [
      ["Garmin Swim™ 2"],
      "https://static.garmincdn.com/en/products/010-02247-00/g/rf-sm-d2856784-66cb-4e0f-a055-a23f242e5ce2.jpg",
    ],
    [
      ["MARQ™ Golfer"],
      "https://static.garmincdn.com/en/products/010-02394-00/g/pd-01-sm-fab01f49-dd1d-4d6e-8519-0d817c1ae674.jpg",
    ],
    [
      ["quatix® 6"],
      "https://static.garmincdn.com/en/products/010-02158-90/g/rf-sm-c3bd24e1-838f-41a5-b84b-45f8c3bc33ec.jpg",
    ],
    [
      ["quatix® 6X", "quatix® 6X Solar", "quatix® 6X Dual Power"],
      "https://static.garmincdn.com/en/products/010-02157-30/g/rf-sm-08137167-34a8-4a4b-8065-ab9f72810db0.jpg",
    ],
    [
      ["Mercedes-Benz Venu®"],
      "https://static.garmincdn.com/en/products/010-02173-52/v/cf-sm-86fc3396-766b-408e-9755-0c8fb5bbacc5.jpg",
    ],
    [["Edge® 1060"], "https://res.garmin.com/en/products/010-04598-00/g/cf-sm.jpg"],
    [["fenix® 9 - 43 mm"], "https://res.garmin.com/en/products/010-04761-00/v/c1_01_md.png"],
    [
      ["fenix® 9 – 47 mm", "fenix® 9 - 51 mm"],
      "https://res.garmin.com/en/products/010-04762-00/v/c1_01_md.png",
    ],
    [
      ["fenix® 9 Pro - 47 mm", "fenix® 9 Pro - inReach 47 mm"],
      "https://res.garmin.com/en/products/010-04336-00/v/c1_01_md.png",
    ],
    [
      ["fenix® 9 Pro - 43 mm", "fenix® 9 Pro - inReach 43 mm"],
      "https://res.garmin.com/en/products/010-04335-00/v/c1_01_md.png",
    ],
    [
      ["fenix® 9 Pro - 51 mm", "fenix® 9 Pro - inReach 51 mm"],
      "https://res.garmin.com/en/products/010-04337-01​/v/c1_01_md.png",
    ],
    [
      ["fenix® 9 Pro - Solar 47 mm", "fenix® 9 Pro - inReach Solar 47 mm"],
      "https://res.garmin.com/en/products/010-04338-00/v/c1_01_md.png",
    ],
    [
      ["fenix® 9 Pro - Solar 51 mm", "fenix® 9 Pro - inReach Solar 51 mm"],
      "https://res.garmin.com/en/products/010-04339-00/v/c1_01_md.png",
    ],
    [["Approach® S72 - 43 mm"], "https://res.garmin.com/en/products/010-04147-00/v/c1_01_md.png"],
    [["Approach® S72 - 47 mm"], "https://res.garmin.com/en/products/010-04148-00/v/c1_01_md.png"],
    [["Enduro™ 4"], "https://res.garmin.com/en/products/010-04799-00/v/c1_01_md.png"],
    [
      [
        "MARQ® Adventurer (Gen 3)",
        "MARQ® Athlete (Gen 3)",
        "MARQ® Aviator (Gen 3)",
        "MARQ® Commander (Gen 3)",
        "MARQ® Diver (Gen 3)",
        "MARQ® Golfer (Gen 3)",
      ],
      "https://res.garmin.com/en/products/010-04549-00/v/c1_01_md.png",
    ],
  ];

export default GARMIN_DEVICE_CATALOG;
