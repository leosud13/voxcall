import md5Lib from 'js-md5';

export function md5(value) {
  return md5Lib(String(value ?? ''));
}
