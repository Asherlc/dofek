type PixelScaler = (baselineValue: number) => number;

export function createRoundLoginLayout(scale: PixelScaler, deviceWidth: number) {
  const hintX = scale(40);
  const buttonHeight = scale(44);

  return {
    hint: {
      x: hintX,
      y: scale(310),
      w: deviceWidth - hintX * 2,
      h: scale(72),
    },
    button: {
      x: scale(102),
      y: scale(386),
      w: scale(276),
      h: buttonHeight,
      radius: Math.ceil(buttonHeight / 2),
    },
  };
}
