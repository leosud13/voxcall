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

  async addCallRecord(record) {
    const history = await this.getCallHistory();
    history.unshift(record);
    if (history.length > 200) history.length = 200;
    await this.setCallHistory(history);
    return history;
  }
}

export const storage = new Storage();
