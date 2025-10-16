import { CardType } from 'src/shared/database/models/user-cards.model';

export class CancelSubscriptionDto {
  telegramId: string;
  cardType: CardType;
  cardLastDigits: string;
}
