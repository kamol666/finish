import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { Plan } from 'src/shared/database/models/plans.model';
import { PaymentProvider, PaymentTypes, Transaction, TransactionStatus } from 'src/shared/database/models/transactions.model';
import { CardType, UserCardsModel } from 'src/shared/database/models/user-cards.model';
import { UserSubscription } from 'src/shared/database/models/user-subscription.model';
import { clickAuthHash } from 'src/shared/utils/hashing/click-auth-hash';
import logger from 'src/shared/utils/logger';
import { PaymentCardTokenDto } from 'src/shared/utils/types/interfaces/payme-types';
import { CreateCardTokenDto } from './dto/create-card-dto';
import { VerifyCardTokenDto } from './dto/verif-card-dto';
import { CreateCardTokenResponseDto } from 'src/shared/utils/types/interfaces/click-types-interface';
import { UserModel } from 'src/shared/database/models/user.model';
import { BotService } from 'src/modules/bot/bot.service';

@Injectable()
export class ClickSubsApiService {

    private readonly serviceId = process.env.CLICK_SERVICE_ID;
    private readonly baseUrl = 'https://api.click.uz/v2/merchant';
    private botService: BotService;


    getBotService(): BotService {
        if (!this.botService) {
            this.botService = new BotService();
        }
        return this.botService;
    }


    async createCardtoken(requestBody: CreateCardTokenDto) {
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Auth': clickAuthHash()
        };

        interface RequestBody {
            service_id: string,
            card_number: string,
            expire_date: string,
            temporary: boolean,
        }

        if (!this.serviceId) {
            throw new Error('Service ID is not defined');
        }
        const requestBodyWithServiceId: RequestBody = {
            service_id: this.serviceId,
            card_number: requestBody.card_number,
            expire_date: requestBody.expire_date,
            temporary: requestBody.temporary
        };

        try {

            console.log("Request data:", requestBodyWithServiceId);
            const response = await axios.post(
                `${this.baseUrl}/card_token/request`,
                requestBodyWithServiceId,
                { headers }
            );

            console.log("Received response data:", response.data);

            if (response.data.error_code !== 0) {
                throw new Error("Response error code is not 0");
            }
            const result: CreateCardTokenResponseDto = new CreateCardTokenResponseDto();


            result.token = response.data.card_token;
            result.incompletePhoneNumber = response.data.phone_number;

            return result;
        } catch (error) {
            // Handle errors appropriately
            console.error('Error creating card token:', error);
            throw error;
        }
    }

    async verifyCardToken(requestBody: VerifyCardTokenDto) {
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Auth': clickAuthHash()
        };

        interface RequestBody {

            service_id: string
            card_token: string,
            sms_code: number,
        }

        if (!this.serviceId) {
            throw new Error('Service ID is not defined');
        }

        const requestBodyWithServiceId: RequestBody = {
            service_id: this.serviceId,
            card_token: requestBody.card_token,
            sms_code: requestBody.sms_code
        };


        try {
            const response = await axios.post(
                `${this.baseUrl}/card_token/verify`, // Changed endpoint to verify
                requestBodyWithServiceId,
                { headers }
            );


            if (response.data.error_code !== 0) {
                throw new Error(`Verification failed: ${response.data.error_message || 'Unknown error'}`);
            }

            const user = await UserModel.findOne({
                _id: requestBody.userId,
            });


            if (!user) {
                logger.error(`User not found for ID: ${requestBody.userId}`);
                throw new Error('User not found');
            }
            logger.info(`User found: ${user}`);


            const plan = await Plan.findOne({
                _id: requestBody.planId
            });
            if (!plan) {
                logger.error(`Plan not found for ID: ${requestBody.planId}`);
                throw new Error('Plan not found');
            }

            console.log(plan)


            const time = new Date().getTime();
            logger.info(`Creating user card for user ID: ${requestBody.userId}, with card token: ${requestBody.card_token}`);

            // Check if user already has a card and update it, otherwise create new one
            const existingCard = await UserCardsModel.findOne({ telegramId: user.telegramId, cardType: CardType.CLICK });

            const existingCardByNumber = await UserCardsModel.findOne({
                incompleteCardNumber: response.data.card_number,
                cardType: CardType.CLICK,
                telegramId: { $ne: user.telegramId },
                isDeleted: { $ne: true },
            });

            if (existingCardByNumber) {
                return {
                    success: false,
                    error: {
                        code: -6,
                        message: 'Bu karta raqam mavjud. Iltimos boshqa karta raqamini tanlang.',
                    },
                };
            }

            let userCard = await UserCardsModel.findOne({
                telegramId: user.telegramId,
                cardType: CardType.CLICK,
            });

            if (!userCard) {
                userCard = await UserCardsModel.findOne({
                    telegramId: user.telegramId,
                });
            }

            if (!userCard) {
                logger.info(`Creating new CLICK card for user: ${user.telegramId}`);
                userCard = new UserCardsModel({
                    telegramId: user.telegramId,
                    cardType: CardType.CLICK,
                });
            } else {
                logger.info(`Updating existing CLICK card for user: ${user.telegramId}`);
            }

            userCard.username = user.username ? user.username : undefined;
            userCard.userId = requestBody.userId as any;
            userCard.planId = requestBody.planId as any;
            userCard.incompleteCardNumber = response.data.card_number;
            userCard.cardToken = requestBodyWithServiceId.card_token;
            userCard.expireDate = requestBody.expireDate;
            userCard.verificationCode = requestBody.sms_code;
            userCard.verified = true;
            userCard.verifiedDate = new Date(time);
            userCard.isDeleted = false;
            userCard.deletedAt = undefined;

            await userCard.save();
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + 30);

            await UserSubscription.create({
                user: requestBody.userId,
                plan: requestBody.planId,
                telegramId: user.telegramId,
                planName: plan.name,
                subscriptionType: 'subscription',
                startDate: new Date(),
                endDate: endDate,
                isActive: true,
                autoRenew: true,
                status: 'active',
                paidAmount: plan.price,
                paidBy: CardType.CLICK,
                subscribedBy: CardType.CLICK,
                hasReceivedFreeBonus: true
            });
            const successResult = response.data;
            if (user.hasReceivedFreeBonus) {
                if (requestBody.selectedService === 'yulduz') {
                    await this.getBotService().handleCardAddedWithoutBonus(
                        requestBody.userId,
                        user.telegramId,
                        CardType.CLICK,
                        plan,
                        user.username,
                        requestBody.selectedService
                    );
                    return successResult;
                }

            }
            user.subscriptionType = 'subscription'
            await user.save();


            if (requestBody.selectedService === 'yulduz') {
                await this.getBotService().handleAutoSubscriptionSuccess(
                    requestBody.userId,
                    user.telegramId,
                    requestBody.planId,
                    user.username
                );
            }


            return response.data;
        } catch (error) {
            console.error('Error verifying card token:', error);
            throw error;
        }


    }


    async paymentWithToken(requestBody: PaymentCardTokenDto) {
        const userCard = await UserCardsModel.findOne({
            userId: requestBody.userId,
            telegramId: requestBody.telegramId,
            verified: true,
            cardType: CardType.CLICK,
            isDeleted: { $ne: true },
        });

        if (!userCard || !this.serviceId) {
            return { success: false };
        }

        if (userCard.cardType !== CardType.CLICK) {
            logger.error(`Card type is not CLICK for User ID: ${requestBody.userId}`);
            return {
                success: false,
            }
        }

        const plan = await Plan.findById(requestBody.planId);
        if (!plan) {
            logger.error('Plan not found');
            return {
                success: false,
            }
        }

        const headers = this.getHeaders();

        const payload = {
            service_id: this.serviceId,
            card_token: userCard.cardToken,
            amount: "5555",
            transaction_parameter: "67a35e3f20d13498efcac2f0",
            transaction_param3: requestBody.userId,
            transaction_param4: "merchant" // test this later
        };

        try {
            const response = await axios.post(
                `${this.baseUrl}/card_token/payment`,
                payload,
                { headers });


            const { error_code } = response.data;

            logger.error(`Error code from response: ${error_code}`);

            if (error_code === -5017) {
                // Handle insufficient funds case
                logger.error(`Insufficient funds for user ID: ${requestBody.userId}`);
                return { success: false };
            }

            const paymentId = response.data.payment_id;

            const customRandomId = `subscription-click-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;


            const transaction = await Transaction.create(
                {
                    provider: PaymentProvider.CLICK,
                    paymentType: PaymentTypes.SUBSCRIPTION,
                    transId: paymentId ? paymentId : customRandomId,
                    amount: '5555',
                    status: TransactionStatus.PAID,
                    userId: requestBody.userId,
                    planId: requestBody.planId,
                }
            )

            logger.info(`Transaction created in click-subs-api: ${JSON.stringify(transaction)}`);


            const endDate = new Date();
            endDate.setDate(endDate.getDate() + 30);

            await UserSubscription.create({
                user: requestBody.userId,
                plan: requestBody.planId,
                telegramId: requestBody.telegramId,
                planName: plan.name,
                subscriptionType: 'subscription',
                startDate: new Date(),
                endDate: endDate,
                isActive: true,
                autoRenew: true,
                status: 'active',
                paidBy: CardType.CLICK,
                subscribedBy: CardType.CLICK,
                hasReceivedFreeBonus: true,
                paidAmount: plan.price // Add the missing paidAmount field
            });

            logger.info(`UserSubscription created for user ID: ${requestBody.userId}, telegram ID: ${requestBody.telegramId}, plan ID: ${requestBody.planId} in click-subs-api`);


            return { success: true };

        } catch {
            return { success: false };
        }


    }

    private getHeaders() {
        return {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Auth': clickAuthHash()
        };
    }

    async deleteCard(cardToken: string): Promise<boolean> {
        if (!this.serviceId) {
            logger.error('Service ID is not configured for Click card deletion');
            return false;
        }

        try {
            const response = await axios.delete(
                `${this.baseUrl}/card_token/${this.serviceId}/${encodeURIComponent(cardToken)}`,
                { headers: this.getHeaders() }
            );

            if (response.data?.error_code === 0) {
                return true;
            }

            logger.error(
                `Failed to delete Click card. Response: ${JSON.stringify(response.data)}`
            );
            return false;
        } catch (error) {
            logger.error('Error deleting Click card:', error);
            return false;
        }
    }

}
