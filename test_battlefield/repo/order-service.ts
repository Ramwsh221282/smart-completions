import { Order } from './types';
import { UserService } from './user-service';

export class OrderService {
    constructor(private readonly users: UserService) {}

    describeOrder(order: Order): string {
        const name = this.users.getDisplayName(order.userId);
        return `Order ${order.id} for ${name}: ${order.total}`;
    }

    describeMany(orders: Order[]): string[] {
        return orders.map(order => this.describeOrder(order));
    }
}
