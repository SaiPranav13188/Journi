// On Android/iOS, expo-sqlite provides a persistent localStorage for the auth session.
import 'expo-sqlite/localStorage/install';

export const authStorage = globalThis.localStorage;
