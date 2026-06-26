import { User } from './types';

export class UserRepository {
    private readonly users = new Map<string, User>();

    save(user: User): void {
        this.users.set(user.id, user);
    }

    findById(id: string): User | undefined {
        return this.users.get(id);
    }

    all(): User[] {
        return Array.from(this.users.values());
    }
}
