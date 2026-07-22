export class Storage {
  async getAll() {
    return window.voxcall.store.getAll();
  }

  async getSip() {
    const data = await this.getAll();
    return data.sip || {};
  }

  async setSip(sip) {
    return window.voxcall.store.set('sip', sip);
  }

  async getToggles() {
    const data = await this.getAll();
    return data.toggles || {};
  }

  async setToggles(toggles) {
    return window.voxcall.store.set('toggles', toggles);
  }

  async getTheme() {
    const data = await this.getAll();
    return data.theme || 'dark';
  }

  async setTheme(theme) {
    return window.voxcall.store.set('theme', theme);
  }

  async getCustomLogos() {
    const data = await this.getAll();
    return data.customLogos || { dark: '', light: '' };
  }

  async setCustomLogos(customLogos) {
    return window.voxcall.store.set('customLogos', customLogos);
  }

  async getBrandLogos() {
    const data = await this.getAll();
    return data.brandLogos || { titulo: '', webphone: '' };
  }

  async setBrandLogos(brandLogos) {
    return window.voxcall.store.set('brandLogos', brandLogos);
  }

  async getContacts() {
    const data = await this.getAll();
    return data.contacts || [];
  }

  async setContacts(contacts) {
    return window.voxcall.store.set('contacts', contacts);
  }

  async getCallHistory() {
    const data = await this.getAll();
    return data.callHistory || [];
  }

  async setCallHistory(history) {
    return window.voxcall.store.set('callHistory', history);
  }

  async getAuth() {
    const data = await this.getAll();
    return data.auth || {};
  }

  async setAuth(auth) {
    return window.voxcall.store.set('auth', auth);
  }

  async addCallRecord(record) {
    const history = await this.getCallHistory();
    history.unshift(record);
    if (history.length > 200) history.length = 200;
    await this.setCallHistory(history);
    return history;
  }
}

export const storage = new Storage();
