import { User } from './types';
import { UserRepository } from './user-repository';

export class UserService {
    constructor(private readonly repository: UserRepository) {}

    getUserById(id: string): User | undefined {
        return this.repository.findById(id);
    }

    getDisplayName(id: string): string {
        const user = this.repository.findById(id);
        return user ? user.fullName : 'unknown';
    }

    listEmails(): string[] {
        return this.repository.all().map(user => user.email);
    }
}
