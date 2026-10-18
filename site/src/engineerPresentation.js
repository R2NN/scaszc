/** Normalize the known Moscow namespace only; other regions retain their identity. */
export const engineerIdentity = engineer => String(engineer?.sourceId || engineer?.id || engineer || '').replace(/^moscow:/, '');

const humanEngineerNames = ['Алексей Волков','Дмитрий Матвеев','Сергей Орлов','Андрей Соколов','Михаил Лебедев','Илья Морозов','Павел Рыбин','Никита Фёдоров','Антон Смирнов','Максим Зайцев','Михаил Волков','Максим Козлов','Сергей Белов','Иван Кузнецов','Александр Павлов','Денис Крылов','Роман Орехов','Егор Фомин','Владислав Егоров','Артём Никитин','Иван Сергеев','Кирилл Андреев','Олег Воронов','Виктор Ларионов','Глеб Макаров','Николай Фролов','Степан Титов','Пётр Данилов','Рустам Алиев','Юрий Громов','Константин Брагин','Вадим Назаров','Арсений Котов','Лев Миронов','Тимур Белов'];
/** Format display names without changing the operational engineer identity. */
export const ratingName = engineer => {
  if (!engineer?.name?.startsWith('Бригада ')) {
    const legacy = {
      'Ионов Геннадий': 'Геннадий Ионов',
      'Брюзгин Ярослав': 'Ярослав Брюзгин',
      'Капитанчук Александр': 'Александр Капитанчук',
      'Исхаков Денис': 'Денис Исхаков',
      'Данилов Даниил': 'Даниил Данилов',
      'Рыбалкин Егор': 'Егор Рыбалкин',
      'Сакур Тимофей': 'Тимофей Сакур',
      'Прокопенко Вячеслав': 'Вячеслав Прокопенко',
      'Выговский Сергей': 'Сергей Выговский',
      'Переладов Алексей': 'Алексей Переладов',
      'Бахарев Андрей': 'Андрей Бахарев',
    };
    return legacy[engineer?.name] || engineer?.name || 'Инженер';
  }
  const match = engineerIdentity(engineer).match(/^(EAST|SOUTHEAST|SOUTHCENTER)-ENG-(\d+)$/);
  const offset = match ? (match[1] === 'EAST' ? 0 : match[1] === 'SOUTHEAST' ? 12 : 24) : 0;
  const index = match ? offset + Number(match[2]) - 1 : -1;
  return humanEngineerNames[index] || engineer.name.replace(/^Бригада\s+/, '');
};
