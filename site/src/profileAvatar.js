export const PROFILE_AVATAR_TONES = [
  { id: 'honey', label: 'Медовый', color: '#FFF1A8' },
  { id: 'mint', label: 'Мятный', color: '#DDF5E9' },
  { id: 'sky', label: 'Небесный', color: '#DDEBFF' },
  { id: 'lilac', label: 'Сиреневый', color: '#E9E0FF' },
  { id: 'peach', label: 'Персиковый', color: '#FFE2D6' },
  { id: 'rose', label: 'Розовый', color: '#FFE0EA' },
  { id: 'silver', label: 'Серебристый', color: '#E7EAEE' },
];

export const profileAvatarColor = profile =>
  PROFILE_AVATAR_TONES.find(item => item.id === (profile?.avatarTone || 'honey'))?.color || PROFILE_AVATAR_TONES[0].color;
