"""Исключения маршрутизатора без неявных fallback-сценариев."""


class RoutingError(Exception):
    """Базовая ошибка маршрутизации."""


class InvalidRoutingInput(RoutingError):
    """Входные данные противоречат контракту маршрутизатора."""


class MissingApiKey(RoutingError):
    """Не найден обязательный API-ключ."""


class ProviderHttpError(RoutingError):
    """Провайдер вернул HTTP-ошибку."""


class ProviderResponseError(RoutingError):
    """Ответ провайдера не соответствует документированной схеме."""


class RoutingIncomplete(RoutingError):
    """Запрошенный набор маршрутов содержит UNKNOWN или отсутствующие элементы."""


class CacheIntegrityError(RoutingError):
    """Контрольная сумма или структура снимка маршрутов повреждена."""


class CacheFrozen(RoutingError):
    """Зафиксированный снимок маршрутов запрещено изменять."""


class UsageBudgetExceeded(RoutingError):
    """Следующий сетевой запрос превысил бы установленный жёсткий лимит."""


class ProviderAccessSuspended(RoutingError):
    """Сетевой доступ к провайдеру запрещён политикой аккаунта."""
