import { generateId, normalizePhone, isValidPhone } from './utils.js';
import { storage } from './storage.js';

export class ContactsManager {
  constructor() {
    this.contacts = [];
    this.searchQuery = '';
  }

  async load() {
    this.contacts = await storage.getContacts();
    return this.contacts;
  }

  async save() {
    await storage.setContacts(this.contacts);
  }

  getFiltered() {
    const q = this.searchQuery.toLowerCase().trim();
    let list = [...this.contacts];
    if (q) {
      list = list.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        (c.email || '').toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.name.localeCompare(b.name, 'pt-BR');
    });
    return list;
  }

  async add({ name, phone, email, company }) {
    if (!name?.trim()) throw new Error('Nome é obrigatório.');
    if (!isValidPhone(phone)) throw new Error('Número de telefone inválido.');
    const contact = {
      id: generateId(),
      name: name.trim(),
      phone: normalizePhone(phone),
      email: (email || '').trim(),
      company: (company || '').trim(),
      favorite: false,
      createdAt: new Date().toISOString(),
    };
    this.contacts.push(contact);
    await this.save();
    return contact;
  }

  async update(id, data) {
    const idx = this.contacts.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error('Contato não encontrado.');
    if (data.phone && !isValidPhone(data.phone)) throw new Error('Número inválido.');
    this.contacts[idx] = {
      ...this.contacts[idx],
      ...data,
      phone: data.phone ? normalizePhone(data.phone) : this.contacts[idx].phone,
      name: data.name?.trim() || this.contacts[idx].name,
    };
    await this.save();
    return this.contacts[idx];
  }

  async remove(id) {
    this.contacts = this.contacts.filter((c) => c.id !== id);
    await this.save();
  }

  async toggleFavorite(id) {
    const c = this.contacts.find((x) => x.id === id);
    if (c) {
      c.favorite = !c.favorite;
      await this.save();
    }
    return c;
  }

  findByPhone(phone) {
    const n = normalizePhone(phone);
    return this.contacts.find((c) => normalizePhone(c.phone) === n);
  }
}

export const contactsManager = new ContactsManager();
