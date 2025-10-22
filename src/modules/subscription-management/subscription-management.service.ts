import { Injectable, BadRequestException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import mongoose from 'mongoose';
import { CancelSubscriptionDto } from './dto/cancel-subscription.dto';
import { CardType, IUserCardsDocument, UserCardsModel } from 'src/shared/database/models/user-cards.model';
import { UserModel } from 'src/shared/database/models/user.model';
import { UserSubscription } from 'src/shared/database/models/user-subscription.model';
import logger from 'src/shared/utils/logger';
import { PaymeSubsApiService } from '../payment-providers/payme-subs-api/payme-subs-api.service';
import { ClickSubsApiService } from '../payment-providers/click-subs-api/click-subs-api.service';
import { UzcardOnetimeApiService } from '../payment-providers/uzcard-onetime-api/uzcard-onetime-api.service';
import { buildSubscriptionManagementLink, buildSubscriptionCancellationLink } from 'src/shared/utils/payment-link.util';

@Injectable()
export class SubscriptionManagementService {
  constructor(
    private readonly paymeSubsApiService: PaymeSubsApiService,
    private readonly clickSubsApiService: ClickSubsApiService,
    private readonly uzcardOnetimeApiService: UzcardOnetimeApiService,
  ) { }

  async cancelSubscription(dto: CancelSubscriptionDto) {
    const telegramId = this.parseTelegramId(dto.telegramId);

    const user = await UserModel.findOne({ telegramId });
    if (!user) {
      throw new NotFoundException(
        'Foydalanuvchi topilmadi. Telegram ID raqamini tekshiring.',
      );
    }

    const cards = await UserCardsModel.find({
      userId: user._id,
      isDeleted: { $ne: true },
    }).exec();
    const now = new Date();

    for (const card of cards) {
      const providerRemoved = await this.removeProviderCard(card);
      if (!providerRemoved) {
        logger.warn(
          `Provider removal failed for user ${user._id} cardType=${card.cardType}`,
        );
      }
    }

    const applyCancellationUpdates = async (
      session?: mongoose.ClientSession,
    ): Promise<void> => {
      const options = session ? { session } : undefined;

      await UserCardsModel.updateMany(
        { userId: user._id, isDeleted: { $ne: true } },
        {
          $set: {
            isDeleted: true,
            deletedAt: now,
          },
          $unset: {
            cardToken: '',
            incompleteCardNumber: '',
            expireDate: '',
            verificationCode: '',
            UzcardId: '',
            UzcardIdForDeleteCard: '',
            UzcardIncompleteNumber: '',
            UzcardOwner: '',
            UzcardIsTrusted: '',
            UzcardBalance: '',
          },
        },
        options,
      );

      await UserSubscription.updateMany(
            { user: user._id, isActive: true },
      
        {
          $set: {
            isActive: false,
            autoRenew: false,
            status: 'cancelled',
            endDate: now,
          },
        },
        options,
      );

      await UserModel.updateOne(
        { _id: user._id },
        {
          $set: {
            isActive: false,
            subscriptionEnd: now,
          },
          $unset: {
            activeInviteLink: '',
          },
        },
        options,
      );
    };

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await applyCancellationUpdates(session);
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? '');

      if (
        message.includes('Transaction') ||
        message.includes('replica set') ||
        message.includes('transact')
      ) {
        logger.warn(
          `Transactions unsupported for subscription cancellation, applying fallback update flow for user=${user._id}`,
          { error: message },
        );
        await applyCancellationUpdates();
      } else {
        logger.error(
          `Subscription cancellation failed for user=${user._id}`,
          error,
        );
        throw new InternalServerErrorException(
          'Obunani bekor qilishda xatolik yuz berdi.',
        );
      }
    } finally {
      await session.endSession();
    }

    logger.info(`Subscription cancelled for telegramId=${telegramId}`);

    return {
      success: true,
      message: 'Obuna muvaffaqiyatli bekor qilindi.',
    };
  }

  getCancellationLink(): string | undefined {
    return this.resolveCancellationLink();
  }

  buildCancellationUrlForUser(telegramId: number | string): string | undefined {
    return buildSubscriptionCancellationLink(telegramId);
  }

  private parseTelegramId(input: string): number {
    const digitsOnly = input?.replace(/\D/g, '');
    if (!digitsOnly) {
      throw new BadRequestException('Telegram ID raqamini to‘liq kiriting.');
    }

    const parsed = Number(digitsOnly);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException('Telegram ID noto‘g‘ri formatda.');
    }

    return parsed;
  }

  private async removeProviderCard(card: IUserCardsDocument): Promise<boolean> {
    switch (card.cardType) {
      case CardType.PAYME:
        if (!card.cardToken || !card.cardToken.trim()) {
          logger.warn(
            `Skip Payme card removal due to empty token for card ${card._id.toString()}`,
          );
          return true;
        }
        return this.paymeSubsApiService.removeCard(card.cardToken.trim());
      case CardType.CLICK:
        return this.clickSubsApiService.deleteCard(card.cardToken);
      case CardType.UZCARD:
        return this.uzcardOnetimeApiService.deleteCard(
          card.userId.toString(),
        );
      default:
        logger.error(`Unsupported card type for cancellation: ${card.cardType}`);
        return false;
    }
  }

  private resolveCancellationLink(): string | undefined {
    const link = buildSubscriptionManagementLink('subscription/cancel');
    return link;
  }
}
