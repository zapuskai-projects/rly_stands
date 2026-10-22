import { createContext, useContext } from 'react';
import type { Profile } from '../lib/types';

export interface ProfileValue {
  profile: Profile;
  reload: () => void;
}

export const ProfileContext = createContext<ProfileValue | null>(null);

export function useProfile(): ProfileValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error('Профиль клиента недоступен вне интернет-банка');
  return value;
}
