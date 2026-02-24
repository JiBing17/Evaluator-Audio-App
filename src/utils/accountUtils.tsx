import AsyncStorage from '@react-native-async-storage/async-storage';
import { PerformanceData } from '../components/PerformanceStats';

export interface UserAccount {
  id: string;
  username: string;
  password: string; // Non-encrypted password stored as plain text
  createdAt: string;
  performances: PerformanceData[];
}

export const createAccount = async (username: string, password: string): Promise<UserAccount | null> => {
  // Check if username already exists
  const existingUser = await getUserByUsername(username);
  if (existingUser) {
    console.log('Username already exists');
    return null;
  }

  const account: UserAccount = {
    id: Date.now().toString(),
    username,
    password, // Store password as plain text (non-encrypted as per requirements)
    createdAt: new Date().toISOString(),
    performances: [],
  };
  
  await AsyncStorage.setItem(`user_${account.id}`, JSON.stringify(account));
  await AsyncStorage.setItem('currentUser', account.id);
  
  return account;
};

export const loginUser = async (username: string, password: string): Promise<UserAccount | null> => {
  const user = await getUserByUsername(username);
  
  if (!user) {
    console.log('User not found');
    return null;
  }
  
  if (user.password !== password) {
    console.log('Incorrect password');
    return null;
  }
  
  // Set as current user
  await AsyncStorage.setItem('currentUser', user.id);
  return user;
};

export const getUserByUsername = async (username: string): Promise<UserAccount | null> => {
  const allUsers = await getAllUsers();
  const user = allUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
  return user || null;
};

export const getCurrentUser = async (): Promise<UserAccount | null> => {
  const userId = await AsyncStorage.getItem('currentUser');
  if (!userId) return null;
  
  const userStr = await AsyncStorage.getItem(`user_${userId}`);
  return userStr ? JSON.parse(userStr) : null;
};

export const getAllUsers = async (): Promise<UserAccount[]> => {
  const keys = await AsyncStorage.getAllKeys();
  const userKeys = keys.filter(key => key.startsWith('user_'));
  const users = await AsyncStorage.multiGet(userKeys);
  
  return users.map(([_, value]) => JSON.parse(value!));
};

export const savePerformanceData = async (performanceData: PerformanceData): Promise<void> => {
  const user = await getCurrentUser();
  if (!user) {
    console.log('No user logged in');
    return;
  }

  user.performances.push(performanceData);
  await AsyncStorage.setItem(`user_${user.id}`, JSON.stringify(user));
  
  console.log('Performance saved successfully');
};

export const logoutUser = async (): Promise<void> => {
  await AsyncStorage.removeItem('currentUser');
  console.log('User logged out successfully');
};
