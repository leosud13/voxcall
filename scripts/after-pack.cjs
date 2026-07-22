const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const { rcedit } = await import('rcedit');
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(context.packager.projectDir, 'assets', 'icon.ico');

  await rcedit(exePath, {
    icon: iconPath,
    'version-string': {
      FileDescription: 'VoxCall',
      ProductName: 'VoxCall',
      OriginalFilename: exeName,
    },
  });

  console.log(`App icon embedded: ${exePath}`);
};
