import { useColorScheme } from 'react-native';

const light = {
  background: '#F5F7F6',
  surface: '#FFFFFF',
  surfaceRaised: '#EEF3F0',
  text: '#15211B',
  textMuted: '#5D6B63',
  border: '#DCE5E0',
  primary: '#167654',
  primarySoft: '#DDF2E8',
  onPrimary: '#FFFFFF',
  danger: '#B42318',
  warning: '#9A6700',
  info: '#245AA5',
  tabBar: '#FFFFFF',
};

const dark = {
  background: '#000000',
  surface: '#151A17',
  surfaceRaised: '#202722',
  text: '#E8ECE9',
  textMuted: '#A8B2AC',
  border: '#303A34',
  primary: '#69D1A8',
  primarySoft: '#173B2D',
  onPrimary: '#082117',
  danger: '#FF8A80',
  warning: '#F4C95D',
  info: '#89B4F8',
  tabBar: '#111512',
};

export type AppColors = typeof light;

export function useAppColors(): AppColors {
  return useColorScheme() === 'dark' ? dark : light;
}

export const priorityColors = {
  high: '#D64545',
  medium: '#D98B16',
  low: '#2E7D66',
} as const;

export const categoryColors: Record<string, string> = {
  'Работа': '#245AA5',
  'Личное': '#8A4EA3',
  'Здоровье': '#167654',
};
